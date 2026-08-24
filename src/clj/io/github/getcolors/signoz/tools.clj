(ns io.github.getcolors.signoz.tools
  (:require [cheshire.core :as json]
            [clojure.string :as str]
            [clojure.walk :as walk]
            [green.ansible :as ansible]
            [green.cli :as green-cli]
            [green.process :as process]
            [green.scaffold :as sc]
            [green.tofu :as tofu]
            [green.workflow :as wf]
            [io.github.getcolors.once.utils :as once-utils]
            [io.github.getcolors.signoz.ssh-config :as ssh-config]
            [io.github.getcolors.signoz.validate :as validate]))

(def infrastructure-tool "signoz-infrastructure")
(def dns-tool "signoz-dns")
(def ansible-tool "signoz-ansible")
(def ansible-local-tool "signoz-ansible-local")
(def root "io.github.getcolors.signoz.tools")
(def template-opts sc/preserve-jinja-delimiters)

(defn tool-dir [opts tool] (green-cli/stage-dir opts tool {:default-profile "signoz"}))
(defn template [path file] (keyword (str root "." path) file))
(defn spec [source target data] {:template source :target target :data data :opts template-opts})
(defn raw-spec [target content] (sc/content-spec target content))

(defn cidrs [opts k]
  (let [v (get opts k) xs (if (sequential? v) v (str/split (str v) #"[,\s]+"))]
    (->> xs (map (comp str/trim str)) (remove str/blank?) vec)))

(defn credential-env [opts & slots]
  (not-empty
   (into {} (keep (fn [[k env-var]]
                    (when-let [v (not-empty (str (get opts k)))] [env-var v])))
         (apply merge (map #(validate/tofu-env opts %) (conj (vec slots) :provider-backend))))))
(defn backend-credential-env [opts] (credential-env opts))

(defn fallback-params [opts]
  {:ip "192.0.2.10" :user "root" :sudoer "root" :name (:profile opts)})
(defn output-params [result]
  (some-> (get-in result [:tofu/outputs :params]) walk/keywordize-keys))

;; ---------------------------------------------------------------- compute

(defn infrastructure-data [opts]
  (assoc opts
         :ssh-keygen (validate/keygen? opts)
         :ssh-sources-hcl (tofu/hcl-list (cidrs opts :vultr-ssh-sources))
         :http-sources-hcl (tofu/hcl-list (cidrs opts :vultr-http-sources))))

(defn infrastructure-step [opts]
  (let [dir (tool-dir opts infrastructure-tool)
        specs [(spec (template "infrastructure" "main.tf") (str dir "/main.tf")
                     (infrastructure-data opts))]
        result (tofu/tofu-with-spec opts specs
                                    {:dir dir :env (credential-env opts :provider-compute)})]
    (cond
      (wf/failed? result) result
      (= :build (:green/event opts)) (merge result (fallback-params opts))
      (= :delete (:green/event opts)) result
      :else (merge result (fallback-params opts) (output-params result)))))

;; -------------------------------------------------------------------- dns

(defn zone
  "The Cloudflare zone the UI host belongs to (its registrable domain)."
  [opts]
  (once-utils/registrable-domain (:signoz-host opts)))

(defn dns-json [opts]
  (tofu/constructs-json
   [(tofu/construct :resource :cloudflare_dns_record :signoz
                    {:zone_id "${data.cloudflare_zone.zone.id}"
                     :name (:signoz-host opts) :content (:ip opts) :type "A"
                     :proxied true :ttl 1})]))

(defn dns-step [opts]
  (let [dir (tool-dir opts dns-tool)
        data (assoc opts
                    :ip (or (:ip opts) (:ip (fallback-params opts)))
                    :signoz-zone (zone opts))
        specs [(spec (template "dns" "main.tf") (str dir "/main.tf") data)
               (raw-spec (str dir "/record.tf.json") (dns-json data))]]
    (tofu/tofu-with-spec opts specs {:dir dir :env (credential-env opts :provider-dns)})))

;; ---------------------------------------------------------- ansible (local)

(defn ansible-local-data
  "Only what a `build` genuinely knows. The address, the user and the alias are
  run-time facts and reach the play as extra-vars instead, so the rendered
  playbook carries no IP and is identical on every workstation (SSH Config
  Standard §6)."
  [opts]
  (assoc opts
         :ssh-keygen (validate/keygen? opts)
         :ssh-config-identity-file (ssh-config/identity-file opts)))

(defn ansible-local-specs [opts]
  (let [dir (tool-dir opts ansible-local-tool) data (ansible-local-data opts)]
    [(spec (template "ansible-local" "ansible.cfg") (str dir "/ansible.cfg") data)
     (spec (template "ansible-local" "inventory.ini") (str dir "/inventory.ini") data)
     (spec (template "ansible-local" "main.yml") (str dir "/main.yml") data)]))

(defn ansible-local-step
  "Write or remove the `~/.ssh/config` block. The same playbook serves both
  events; `block_state` is what distinguishes them."
  [opts]
  (let [dir (tool-dir opts ansible-local-tool)
        delete? (= :delete (:green/event opts))]
    (ansible/ansible-with-spec opts
      {:dir dir :inventory "inventory.ini"
       :playbooks {:create "main.yml" :delete "main.yml"}
       :extra-vars {:host_alias (ssh-config/host-alias opts)
                    :ip (or (:ip opts) (:ip (fallback-params opts)))
                    :user (or (:user opts) "root")
                    :block_state (if delete? "absent" "present")}}
      (ansible-local-specs opts))))

;; ---------------------------------------------------------------- ansible

(defn inventory [opts]
  (json/generate-string
   {:all {:children {:signoz {:hosts {(:profile opts)
                                      {:ansible_host (or (:ip opts) "192.0.2.10")
                                       :ansible_user "root"}}}}}}
   {:pretty true}))

(defn ansible-data
  "Template values for the Ansible stage.

  Deliberately carries none of the three operator secrets. They reach the host
  as Ansible `lookup('env', ...)` expressions written literally into main.yml,
  where `preserve-jinja-delimiters` passes them through untouched — routing
  them through this map instead would let Selmer HTML-escape the quotes and
  hand Ansible `&#39;`. The secret therefore exists only in the process that
  needs it: not in `.colors/`, not in a golden, not in this map."
  [opts]
  (assoc opts
         :ip (or (:ip opts) "192.0.2.10")
         :ssh-keygen (validate/keygen? opts)))

(defn ansible-specs [opts]
  (let [dir (tool-dir opts ansible-tool) data (ansible-data opts)]
    [(spec (template "ansible" "ansible.cfg") (str dir "/ansible.cfg") data)
     (spec (template "ansible" "main.yml") (str dir "/main.yml") data)
     (spec (template "ansible" "cleanup.yml") (str dir "/cleanup.yml") data)
     (spec (template "ansible" "compose.yml") (str dir "/compose.yml") data)
     (spec (template "ansible" "Caddyfile") (str dir "/Caddyfile") data)
     (spec (template "ansible" "ingester.yaml") (str dir "/ingester.yaml") data)
     (spec (template "ansible" "opamp.yaml") (str dir "/opamp.yaml") data)
     (spec (template "ansible" "keeper.yaml") (str dir "/keeper.yaml") data)
     (spec (template "ansible" "clickhouse.yaml") (str dir "/clickhouse.yaml") data)
     (spec (template "ansible" "functions.yaml") (str dir "/functions.yaml") data)
     (spec (template "ansible" "smoke.sh") (str dir "/smoke.sh") data)
     (spec (template "ansible" "backup.sh") (str dir "/backup.sh") data)
     (spec (template "ansible" "backup.service") (str dir "/backup.service") data)
     (spec (template "ansible" "backup.timer") (str dir "/backup.timer") data)
     (raw-spec (str dir "/inventory.json") (inventory data))]))

(defn ansible-step [opts]
  (let [dir (tool-dir opts ansible-tool)]
    (if (and (= :delete (:green/event opts)) (not (:ip opts)))
      ;; No compute in state: there is no host to stop, and the cleanup play
      ;; would only fail against the placeholder address.
      (assoc opts :green/exit 0)
      (ansible/ansible-with-spec opts
        {:dir dir :inventory "inventory.json"
         :playbooks {:create "main.yml" :delete "cleanup.yml"}
         :host-key-checking false}
        (ansible-specs opts)))))

;; ------------------------------------------------------------- acceptance

(defn wait-for
  "True once `args` exits zero, retrying every five seconds."
  [args attempts]
  (loop [n attempts]
    (let [r (process/run-with-timeout args {} 20000)]
      (cond (zero? (:exit r)) true
            (pos? n) (do (Thread/sleep 5000) (recur (dec n)))
            :else false))))

(defn http-status
  "The status code a request returns, as a string, or \"000\" when the request
  never completed."
  [args]
  (str/trim (str (:out (process/run-with-timeout args {} 20000)))))

(defn acceptance-step
  "Public health checks after a real create.

  The end-to-end ingest proof runs on the server, inside the playbook, where
  the generated ingestion token lives. What is checked from here is what the
  internet can reach: the UI over HTTPS, and an OTLP endpoint that refuses an
  unauthenticated write. The refusal is the point — SigNoz community edition
  has no ingestion keys of its own, so an endpoint that accepted this request
  would be an open write path into ClickHouse."
  [opts]
  (if (not= :create (:green/event opts))
    (assoc opts :green/exit 0)
    (let [base (str "https://" (:signoz-host opts))]
      (cond
        (not (wait-for ["curl" "-fsS" "-o" "/dev/null" (str base "/")] 60))
        (assoc opts :green/exit 1 :green/err "the SigNoz UI did not become reachable over HTTPS")

        :else
        (let [health (http-status
                      ["curl" "-s" "-o" "/dev/null" "-w" "%{http_code}"
                       (str base "/api/v1/health")])
              otlp (http-status
                    ["curl" "-s" "-o" "/dev/null" "-w" "%{http_code}"
                     "-X" "POST" "-H" "content-type: application/json"
                     "--data" "{\"resourceLogs\":[]}" (str base "/v1/logs")])]
          (cond
            (not= "200" health)
            (assoc opts :green/exit 1
                   :green/err (str "the SigNoz API is not healthy: /api/v1/health returned " health))

            (not= "401" otlp)
            (assoc opts :green/exit 1
                   :green/err (str "the public OTLP endpoint is not gated: an unauthenticated "
                                   "/v1/logs returned " otlp " rather than 401"))

            :else
            (assoc opts :green/exit 0
                   :signoz/acceptance {:ui "ok" :health health :otlp-unauthenticated otlp})))))))
