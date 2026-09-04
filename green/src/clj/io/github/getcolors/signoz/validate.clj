(ns io.github.getcolors.signoz.validate
  (:require [clojure.string :as str]
            [green.cli :as green-cli]
            [io.github.getcolors.once.ssh :as once-ssh]
            [io.github.getcolors.once.validate :as once-validate]))

(def profile-par (green-cli/par-name :profile))

(def compute-providers
  "provider-compute -> what that choice implies.

  `:required` are the non-secret keys that provider's template interpolates,
  `:secrets` the credentials it needs through COLORS_PAR_*, and `:tofu-env` the
  subset OpenTofu reads from the process environment itself. Keeping the three
  together is what stops a provider being validated against one set of keys and
  run with another — a stage exporting a credential nobody checked for, or a
  check demanding a key no template uses. The keys of this map are the
  advertised providers; a provider without a template directory and a golden
  is not advertised.

  Two keys the templates read are deliberately not required. `<provider>-name`
  is an optional override of the profile (Compute Name Standard), and
  `<provider>-ssh-keys` is meaningful by its absence (SSH Keypair Standard).
  Keys of the unselected provider are accepted and ignored, so one colors.yml
  stays portable between providers."
  {"digitalocean"
   {:required [:digitalocean-region :digitalocean-size :digitalocean-image
               :digitalocean-ssh-sources :digitalocean-http-sources]
    :secrets [:do-token]
    :tofu-env {:do-token "DIGITALOCEAN_TOKEN"}}
   "vultr"
   {:required [:vultr-region :vultr-plan :vultr-os-id
               :vultr-ssh-sources :vultr-http-sources]
    :secrets [:vultr-api-key]
    :tofu-env {:vultr-api-key "VULTR_API_KEY"}}})

(def default-compute-provider
  "The provider a deployment created before this package recorded one in its
  compute output must be running: the only one it ever offered."
  "vultr")

(def required
  "Every key desired state must carry whichever provider is selected. The
  provider-scoped keys come from `compute-providers`."
  [:profile :workdir :provider-compute :provider-dns :provider-backend
   :compute-prevent-destroy
   :signoz-host :signoz-root-email :signoz-root-org-name
   :signoz-image :signoz-collector-image :signoz-clickhouse-image
   :signoz-clickhouse-keeper-image :signoz-postgres-image :signoz-caddy-image
   :signoz-histogram-quantile-version :signoz-ingestion-token-file
   :signoz-backup-dir :signoz-backup-r2-bucket :signoz-backup-r2-endpoint
   :signoz-backup-r2-region :signoz-backup-oncalendar
   :signoz-backup-retention-days
   :r2-bucket :r2-endpoint])

(def image-keys
  [:signoz-image :signoz-collector-image :signoz-clickhouse-image
   :signoz-clickhouse-keeper-image :signoz-postgres-image :signoz-caddy-image])

(def host-re #"^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$")
(def email-re #"^[^@\s]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$")
(def image-re #"^[^\s:@]+(?:/[^\s:@]+)*(?::[^\s:@]+|@sha256:[0-9a-f]{64})$")
(def abs-path-re #"^/[^\s]*$")
(def name-rules
  "What each provider accepts as a machine name, checked here rather than
  discovered mid-apply. DigitalOcean droplet names are hostname-like; Vultr
  labels are free-form console text, held to a safe subset."
  {"digitalocean" {:re #"^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$"
                   :message "must be a hostname-like name: lowercase letters, digits, dots and hyphens, 1-63 characters"}
   "vultr" {:re #"^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$"
            :message "must be a safe 1-63 character name"}})

(defn missing? [x] (or (nil? x) (and (string? x) (str/blank? x))))

(defn placeholder?
  "Whether a value is missing in the ways a hand-edited file produces: absent,
  blank, or still carrying the scaffold's REPLACE_ME."
  [x]
  (or (missing? x) (= "REPLACE_ME" (str/upper-case (str x)))))

(defn compute-provider [opts] (get compute-providers (:provider-compute opts)))

(defn compute-key
  "Desired state names compute keys after the provider, so the shared steps
  reach them through the selected provider rather than a fixed prefix."
  [opts suffix]
  (keyword (str (:provider-compute opts) "-" suffix)))

(defn compute-name
  "What this deployment's machine is called. The profile is the deployment's
  identity — it keys remote state, names the machine keypair and its provider
  registration, and is the `~/.ssh/config` alias an operator types — so the
  machine's own label must not be the one place that disagrees (Compute Name
  Standard §1). `<provider>-name` overrides it for an account whose naming
  policy a profile cannot satisfy; presence is the only switch, and resolving
  it here means the templates render one value and never branch (§2). The
  firewall derives its name from the same answer (§3)."
  [opts]
  (let [override (get opts (compute-key opts "name"))]
    (if (placeholder? override) (str (:profile opts)) (str override))))

(defn keygen?
  "Whether this deployment owns its machine keypair. Delegates to ONCE, the
  standard's reference implementation, so one rule decides it everywhere."
  [opts]
  (once-ssh/keygen? opts))

(defn cidrs
  "A source list as desired state or an overlay string carries it: a YAML
  list, or one string of comma- or space-separated entries."
  [opts k]
  (let [v (get opts k) xs (if (sequential? v) v (str/split (str v) #"[,\s]+"))]
    (->> xs (map (comp str/trim str)) (remove str/blank?) vec)))

;; Syntactic CIDR checks, the same in every colour and deliberately not a
;; resolver: an address library that accepts a hostname would let a firewall
;; source depend on DNS at apply time.
(def ^:private ipv4-re
  #"^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$")
(def ^:private hex-group-re #"^[0-9A-Fa-f]{1,4}$")

(defn- ipv6-address? [s]
  ;; An IPv4-embedded tail (`::ffff:192.0.2.1`) may stand in the last position
  ;; only, where it occupies two groups; it is folded into two zero groups so
  ;; the group arithmetic below stays the same in every colour.
  (let [colon (str/last-index-of s ":")
        tail (when colon (subs s (inc colon)))
        s (cond
            (nil? colon) nil
            (not (str/includes? tail ".")) s
            (re-matches ipv4-re tail) (str (subs s 0 (inc colon)) "0:0")
            :else nil)
        groups (fn [part] (if (str/blank? part) [] (str/split part #":" -1)))]
    (cond
      (nil? s) false
      (str/includes? s "::")
      (let [halves (str/split s #"::" -1)]
        (and (= 2 (count halves))
             (let [gs (mapcat groups halves)]
               (and (<= (count gs) 7) (every? #(re-matches hex-group-re %) gs)))))
      :else
      (let [gs (groups s)]
        (and (= 8 (count gs)) (every? #(re-matches hex-group-re %) gs))))))

(defn cidr?
  "Whether `s` is a syntactically valid IPv4 or IPv6 CIDR: an address, a
  slash, and a prefix length the address family allows."
  [s]
  (let [[address prefix & more] (str/split (str s) #"/" -1)]
    (and (nil? more) (some? prefix) (re-matches #"^\d{1,3}$" prefix)
         (let [n (Long/parseLong prefix)]
           (cond
             (re-matches ipv4-re address) (<= 0 n 32)
             (ipv6-address? address) (<= 0 n 128)
             :else false)))))

(defn source-errors
  "The network contract: the selected provider's SSH sources must name at
  least one CIDR — a machine nobody can reach is not a deployment — and every
  entry of both lists must be one. An empty HTTP list is allowed and means no
  public HTTP. Refusing beats defaulting: a silent default-open on a host that
  holds telemetry is worse than a validation error."
  [opts]
  (let [ssh-key (compute-key opts "ssh-sources")
        http-key (compute-key opts "http-sources")]
    (concat
     (when (and (not (missing? (get opts ssh-key))) (empty? (cidrs opts ssh-key)))
       [(str ssh-key " must list at least one CIDR")])
     (for [k [ssh-key http-key]
           :when (not (missing? (get opts k)))
           entry (cidrs opts k)
           :when (not (cidr? entry))]
       (str k " entry " (pr-str entry) " is not an IPv4 or IPv6 CIDR")))))

(defn provider-errors
  "Checks that hold only for the selected provider. Keys of the other provider
  are ignored, never refused."
  [opts]
  ;; The *resolved* machine name is what reaches the provider, so it is what
  ;; the rule checks: an explicit override, or the profile it falls back to.
  ;; The error names whichever key produced the value.
  (let [name-key (compute-key opts "name")
        {:keys [re message]} (get name-rules (:provider-compute opts))
        name (compute-name opts)
        source (if (placeholder? (get opts name-key))
                 (str ":profile (the " (:provider-compute opts) " machine name)")
                 (str name-key))]
    (concat
     (when (and re (not (missing? name))
                (or (> (count name) 63) (not (re-matches re name))))
       [(str source " " message)])
     (case (:provider-compute opts)
       "vultr"
       (when-not (or (missing? (:vultr-os-id opts)) (integer? (:vultr-os-id opts)))
         [":vultr-os-id must be Vultr's numeric operating-system id"])
       "digitalocean"
       (concat
        ;; No VPC is created: the region's default is discovered at plan time,
        ;; and a pinned UUID or a CIDR would make this package start owning one.
        (when (contains? opts :digitalocean-vpc-uuid)
          [":digitalocean-vpc-uuid must be absent; the default regional VPC is discovered at runtime"])
        (when (contains? opts :digitalocean-vpc-cidr)
          [":digitalocean-vpc-cidr must be absent; this package must not create a VPC"]))
       nil))))

(defn env-errors [env]
  (when (not-empty (str (get env profile-par)))
    [(str profile-par " is set; profile must come from colors.yml only")]))

(defn state-errors [opts]
  (vec
   (concat
    (for [k (concat required (:required (compute-provider opts)))
          :when (missing? (get opts k))]
      (str k " is required"))
    (when-not (compute-provider opts)
      [(str ":provider-compute must be one of "
            (str/join ", " (sort (keys compute-providers))))])
    (when-not (= "cloudflare" (:provider-dns opts))
      [":provider-dns must be cloudflare"])
    (when-not (contains? #{"local" "s3" "r2"} (:provider-backend opts))
      [":provider-backend must be local, s3, or r2"])
    (when-not (boolean? (:compute-prevent-destroy opts))
      [":compute-prevent-destroy must be true or false"])
    (when-not (or (missing? (:signoz-host opts))
                  (re-matches host-re (str (:signoz-host opts))))
      [":signoz-host must be a fully qualified hostname"])
    (when-not (or (missing? (:signoz-root-email opts))
                  (re-matches email-re (str (:signoz-root-email opts))))
      [":signoz-root-email must be an email address"])
    (for [k image-keys
          :let [v (get opts k)]
          :when (and (not (missing? v)) (not (re-matches image-re (str v))))]
      (str k " must carry an explicit image tag or digest"))
    ;; The application and the collector version independently upstream, and
    ;; the collector owns the ClickHouse schema the application queries. There
    ;; is no rule that can check the pair is compatible, so the one thing that
    ;; can be checked is that neither floats.
    (for [k [:signoz-image :signoz-collector-image]
          :let [v (str (get opts k))]
          :when (or (str/ends-with? v ":latest") (str/ends-with? v ":main"))]
      (str k " must not track a floating tag; pin the version"))
    (when-not (or (missing? (:signoz-ingestion-token-file opts))
                  (re-matches abs-path-re (str (:signoz-ingestion-token-file opts))))
      [":signoz-ingestion-token-file must be an absolute path"])
    (when-not (or (missing? (:signoz-backup-dir opts))
                  (re-matches abs-path-re (str (:signoz-backup-dir opts))))
      [":signoz-backup-dir must be an absolute path"])
    (when-not (or (missing? (:signoz-backup-retention-days opts))
                  (and (integer? (:signoz-backup-retention-days opts))
                       (pos? (:signoz-backup-retention-days opts))))
      [":signoz-backup-retention-days must be a positive integer"])
    (when (compute-provider opts)
      (concat (provider-errors opts) (source-errors opts))))))

(defn provider-state-errors
  "Provider switching is a rebuild, never an apply. Every provider shares one
  state key, so a changed provider-compute on a profile whose state already
  holds compute would plan a cross-provider replacement — and a delete would
  render and destroy the *selected* provider's template against the wrong
  lifecycle. `params` is the compute stage's recorded output, or nil when the
  state holds none; its `provider` is the registry name the template that
  produced it belongs to. A recorded output without one predates this package
  recording it, which makes it the default provider's."
  [opts params]
  (let [selected (:provider-compute opts)
        recorded (some-> (:provider params) str not-empty)]
    (cond
      (nil? params) nil

      (and recorded (not= recorded selected))
      [(str "state holds a " recorded " machine; set provider-compute back to "
            recorded " and delete first")]

      (and (nil? recorded) (not= selected default-compute-provider))
      [(str "state holds a machine with no recorded provider, created before this "
            "package recorded one, which makes it a " default-compute-provider
            " machine; set provider-compute back to " default-compute-provider
            " and delete first")]

      :else nil)))

(defn backend-secrets [opts]
  (:secrets (get-in once-validate/providers
                    [:provider-backend (:provider-backend opts)])))

(defn provider-secrets
  "What talking to the providers needs, on any real event: the selected
  compute provider's credential and Cloudflare's."
  [opts]
  (concat (:secrets (compute-provider opts)) [:cloudflare-api-token]))

(def application-secrets
  "What converging the machine needs, and therefore only a create. The OTLP
  ingestion token and the Postgres password are deliberately absent: both are
  generated on the server and are never supplied by the operator."
  [:signoz-root-password
   :signoz-backup-r2-access-key-id
   :signoz-backup-r2-secret-access-key])

(defn secret-errors
  "Credentials a real event needs. A delete tears down infrastructure and never
  converges anything, so it asks for the provider credentials only; demanding
  the root password to destroy a machine would just be a lock on the exit."
  [opts event]
  (let [keys (concat (provider-secrets opts)
                     (when (= :create event) application-secrets)
                     (backend-secrets opts))]
    (for [k (distinct keys) :when (missing? (get opts k))]
      (str "required credential is not set: " (green-cli/par-name k)))))

(defn tofu-env [opts slot]
  (case slot
    :provider-compute (:tofu-env (compute-provider opts) {})
    :provider-dns {:cloudflare-api-token "CLOUDFLARE_API_TOKEN"}
    :provider-backend (:tofu-env (get-in once-validate/providers
                                         [:provider-backend (:provider-backend opts)]) {})
    {}))
