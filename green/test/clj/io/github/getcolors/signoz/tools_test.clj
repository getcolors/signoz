(ns io.github.getcolors.signoz.tools-test
  (:require [clojure.java.io :as io]
            [clojure.string :as str]
            [clojure.test :refer [deftest is]]
            [io.github.getcolors.signoz.tools :as tools]
            [io.github.getcolors.signoz.validate-test :refer [fixture optout]]))

(defn- spec-for [opts file]
  (some #(when (str/ends-with? (str (:target %)) file) %) (tools/ansible-specs opts)))

(deftest firewall-sources-parse
  (let [data (tools/infrastructure-data (fixture))]
    (is (= ["0.0.0.0/0" "::/0"] (tools/cidrs data :vultr-http-sources)))))

(deftest infrastructure-data-carries-the-ssh-mode
  (is (true? (:ssh-keygen (tools/infrastructure-data (fixture)))))
  (is (false? (:ssh-keygen (tools/infrastructure-data (optout))))))

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
