(ns io.github.getcolors.signoz.validate
  (:require [clojure.string :as str]
            [green.cli :as green-cli]
            [io.github.getcolors.once.ssh :as once-ssh]
            [io.github.getcolors.once.validate :as once-validate]))

(def profile-par (green-cli/par-name :profile))

(def required
  "Every key desired state must carry. `vultr-ssh-keys` is deliberately absent:
  per the SSH Keypair Standard its *absence* selects keygen mode, where the
  package owns the keypair, and requiring it would make conforming deployments
  invalid."
  [:profile :workdir :provider-compute :provider-dns :provider-backend
   :compute-prevent-destroy
   :signoz-host :signoz-root-email :signoz-root-org-name
   :signoz-image :signoz-collector-image :signoz-clickhouse-image
   :signoz-clickhouse-keeper-image :signoz-postgres-image :signoz-caddy-image
   :signoz-histogram-quantile-version :signoz-ingestion-token-file
   :signoz-backup-dir :signoz-backup-r2-bucket :signoz-backup-r2-endpoint
   :signoz-backup-r2-region :signoz-backup-oncalendar
   :signoz-backup-retention-days
   :vultr-name :vultr-region :vultr-plan :vultr-os-id
   :vultr-ssh-sources :vultr-http-sources
   :r2-bucket :r2-endpoint])

(def image-keys
  [:signoz-image :signoz-collector-image :signoz-clickhouse-image
   :signoz-clickhouse-keeper-image :signoz-postgres-image :signoz-caddy-image])

(def host-re #"^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$")
(def email-re #"^[^@\s]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$")
(def image-re #"^[^\s:@]+(?:/[^\s:@]+)*(?::[^\s:@]+|@sha256:[0-9a-f]{64})$")
(def abs-path-re #"^/[^\s]*$")

(defn missing? [x] (or (nil? x) (and (string? x) (str/blank? x))))

(defn keygen?
  "Whether this deployment owns its machine keypair. Delegates to ONCE, the
  standard's reference implementation, so one rule decides it everywhere."
  [opts]
  (once-ssh/keygen? opts))

(defn env-errors [env]
  (when (not-empty (str (get env profile-par)))
    [(str profile-par " is set; profile must come from colors.yml only")]))

(defn state-errors [opts]
  (vec
   (concat
    (for [k required :when (missing? (get opts k))] (str k " is required"))
    (when-not (= "vultr" (:provider-compute opts))
      [":provider-compute must be vultr"])
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
    (when-not (or (missing? (:vultr-os-id opts)) (integer? (:vultr-os-id opts)))
      [":vultr-os-id must be Vultr's numeric operating-system id"]))))

(defn backend-secrets [opts]
  (:secrets (get-in once-validate/providers
                    [:provider-backend (:provider-backend opts)])))

(def provider-secrets
  "What talking to the providers needs, on any real event."
  [:vultr-api-key :cloudflare-api-token])

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
  (let [keys (concat provider-secrets
                     (when (= :create event) application-secrets)
                     (backend-secrets opts))]
    (for [k (distinct keys) :when (missing? (get opts k))]
      (str "required credential is not set: " (green-cli/par-name k)))))

(defn tofu-env [opts slot]
  (case slot
    :provider-compute {:vultr-api-key "VULTR_API_KEY"}
    :provider-dns {:cloudflare-api-token "CLOUDFLARE_API_TOKEN"}
    :provider-backend (:tofu-env (get-in once-validate/providers
                                         [:provider-backend (:provider-backend opts)]) {})
    {}))
