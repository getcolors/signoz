(ns io.github.getcolors.signoz.tools-test
  (:require [clojure.java.io :as io]
            [clojure.string :as str]
            [clojure.test :refer [deftest is]]
            [io.github.getcolors.signoz.tools :as tools]
            [io.github.getcolors.signoz.validate-test :refer [fixture optout do-fixture do-optout]]))

(defn- spec-for [opts file]
  (some #(when (str/ends-with? (str (:target %)) file) %) (tools/ansible-specs opts)))

(deftest firewall-sources-parse
  (let [data (tools/infrastructure-data (fixture))]
    (is (= ["0.0.0.0/0" "::/0"] (tools/cidrs data :vultr-http-sources)))))

(deftest infrastructure-data-carries-the-ssh-mode
  (is (true? (:ssh-keygen (tools/infrastructure-data (fixture)))))
  (is (false? (:ssh-keygen (tools/infrastructure-data (optout)))))
  (is (true? (:ssh-keygen (tools/infrastructure-data (do-fixture)))))
  (is (false? (:ssh-keygen (tools/infrastructure-data (do-optout))))))

(deftest infrastructure-data-reads-the-selected-providers-keys
  ;; The template interpolates one resolved name and one resolved list per
  ;; port, whichever provider they came from.
  (let [data (tools/infrastructure-data (do-fixture :digitalocean-ssh-sources ["10.0.0.0/8"]
                                                    :vultr-ssh-sources ["192.0.2.0/24"]))]
    (is (= "[\"10.0.0.0/8\"]" (:ssh-sources-hcl data)))
    (is (= "signoz-digitalocean-fixture" (:compute-name data))))
  (is (= "signoz-fixture" (:compute-name (tools/infrastructure-data (fixture))))))

(deftest template-directory-follows-the-provider
  (is (= :io.github.getcolors.signoz.tools.infrastructure.vultr/main.tf
         (tools/infrastructure-template (fixture))))
  (is (= :io.github.getcolors.signoz.tools.infrastructure.digitalocean/main.tf
         (tools/infrastructure-template (do-fixture))))
  ;; A registry entry without a template directory would pass every unit test
  ;; and fail the first build.
  (doseq [provider ["vultr" "digitalocean"]]
    (is (io/resource (str "io/github/getcolors/signoz/tools/infrastructure/" provider "/main.tf"))
        provider)))

(deftest fallback-params-are-shaped-per-provider
  (is (= {:provider "vultr" :ip "192.0.2.10" :user "root" :sudoer "root" :name "signoz-fixture"}
         (tools/fallback-params (fixture))))
  (is (= {:provider "digitalocean" :ip "192.0.2.10" :user "root" :sudoer "root"
          :name "signoz-digitalocean-fixture"}
         (tools/fallback-params (do-fixture)))))

(deftest a-real-create-refuses-a-missing-ip-output
  ;; 192.0.2.10 is the documentation address build renders with; a real
  ;; converge must never fall back to it.
  (let [refused (tools/resolved-compute {} (tools/fallback-params (fixture)) nil)]
    (is (= 1 (:green/exit refused)))
    (is (str/includes? (:green/err refused) "compute produced no ip output")))
  (let [refused (tools/resolved-compute {} (tools/fallback-params (fixture)) {:name "x"})]
    (is (= 1 (:green/exit refused))))
  (let [ok (tools/resolved-compute {} (tools/fallback-params (fixture))
                                   {:ip "203.0.113.9" :provider "vultr"})]
    (is (nil? (:green/exit ok)))
    (is (= "203.0.113.9" (:ip ok)))))

(deftest dns-zone-is-registrable-domain
  (is (= "example.com" (tools/zone (fixture)))))

(deftest dns-record-is-host-and-proxied
  (let [json (tools/dns-json (assoc (fixture) :ip "192.0.2.10"))]
    (is (str/includes? json "signoz.example.com"))
    (is (str/includes? json "192.0.2.10"))
    (is (str/includes? json "proxied"))))

(deftest inventory-keeps-one-target
  (let [inventory (tools/inventory (assoc (fixture) :ip "192.0.2.10"))]
    (is (str/includes? inventory "192.0.2.10"))
    (is (str/includes? inventory "signoz-fixture"))))

(deftest ansible-renders-the-whole-stack
  (let [targets (map #(str (:target %)) (tools/ansible-specs (fixture)))]
    (doseq [f ["ansible.cfg" "main.yml" "cleanup.yml" "compose.yml" "Caddyfile"
               "ingester.yaml" "opamp.yaml" "keeper.yaml" "clickhouse.yaml"
               "functions.yaml" "smoke.sh" "backup.sh" "backup.service"
               "backup.timer" "inventory.json"]]
      (is (some #(str/ends-with? % f) targets) f))))

(deftest operator-secrets-reach-the-host-as-lookups-not-values
  ;; `.colors/` is generated output and the goldens are committed, so the
  ;; secret must never be the thing that lands on disk — the expression is.
  ;; The lookups live literally in the template rather than in the data map,
  ;; because Selmer HTML-escapes a value it interpolates and Ansible would
  ;; receive `&#39;` instead of a quote.
  (let [template (slurp (io/resource "io/github/getcolors/signoz/tools/ansible/main.yml"))]
    (doseq [par ["COLORS_PAR_SIGNOZ_ROOT_PASSWORD"
                 "COLORS_PAR_SIGNOZ_BACKUP_R2_ACCESS_KEY_ID"
                 "COLORS_PAR_SIGNOZ_BACKUP_R2_SECRET_ACCESS_KEY"]]
      (is (str/includes? template (str "lookup('env','" par "')")) par))))

(deftest the-data-map-carries-no-operator-secret
  (let [data (:data (spec-for (fixture) "main.yml"))]
    (is (= "admin@signoz.example.com" (:signoz-root-email data)))
    (doseq [k [:signoz-root-password :signoz-backup-access-key :signoz-backup-secret-key]]
      (is (nil? (get data k)) (str k)))))

(deftest a-delete-without-compute-skips-the-host-entirely
  ;; There is no machine to stop, and the cleanup play would only fail against
  ;; the placeholder address.
  (is (= 0 (:green/exit (tools/ansible-step (assoc (fixture) :green/event :delete))))))

(deftest acceptance-is-skipped-outside-a-real-create
  (doseq [event [:build :delete]]
    (is (= 0 (:green/exit (tools/acceptance-step (assoc (fixture) :green/event event)))))))
