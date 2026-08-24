(ns io.github.getcolors.signoz.validate-test
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is]]
            [green.cli :as green-cli]
            [io.github.getcolors.signoz.validate :as validate]))

(def fixture-file "test/fixtures/colors.yml")
(def optout-file "test/fixtures/optout.yml")

(defn- read-fixture [path overrides]
  (merge (green-cli/read-state path (str/replace (slurp path) "WORKDIR" ".colors"))
         overrides))
(defn fixture [& {:as overrides}] (read-fixture fixture-file overrides))
(defn optout [& {:as overrides}] (read-fixture optout-file overrides))

(deftest fixture-is-valid (is (= [] (validate/state-errors (fixture)))))

(deftest optout-fixture-is-valid (is (= [] (validate/state-errors (optout)))))

(deftest machine-key-is-not-required
  ;; The standard makes absence meaningful: requiring vultr-ssh-keys would make
  ;; every conforming deployment invalid.
  (is (not-any? #(str/includes? % "vultr-ssh-keys") (validate/state-errors (fixture)))))

(deftest absent-machine-key-selects-keygen
  (is (true? (validate/keygen? (fixture))))
  (is (false? (validate/keygen? (optout)))))

(deftest reports-all-errors
  (let [errors (validate/state-errors
                (fixture :signoz-host "bad" :signoz-image "floating"
                         :signoz-root-email "not-an-email"
                         :provider-dns "other" :provider-compute "digitalocean"
                         :signoz-backup-retention-days 0
                         :signoz-backup-dir "relative/path"
                         :vultr-os-id "2284"))]
    (is (<= 8 (count errors)))
    (doseq [part ["host" "image" "root-email" "provider-dns" "vultr" "os-id"
                  "retention-days" "backup-dir"]]
      (is (some #(str/includes? % part) errors) part))))

(deftest accepts-a-digest-pin
  (is (= [] (validate/state-errors
             (fixture :signoz-caddy-image
                      (str "caddy@sha256:" (apply str (repeat 64 "a"))))))))

(deftest the-application-and-collector-may-not-float
  ;; They version independently upstream and share a schema, so nothing can
  ;; check the pair is compatible. What can be checked is that neither moves on
  ;; its own between converges.
  (doseq [k [:signoz-image :signoz-collector-image]]
    (let [errors (validate/state-errors (fixture k "signoz/signoz:latest"))]
      (is (some #(str/includes? % "floating tag") errors) (str k)))))

(deftest profile-overlay-is-refused
  (is (seq (validate/env-errors {"COLORS_PAR_PROFILE" "other"})))
  (is (nil? (validate/env-errors {}))))

(deftest a-create-names-every-package-secret
  (let [errors (str/join "\n" (validate/secret-errors (fixture) :create))]
    (doseq [name ["COLORS_PAR_VULTR_API_KEY" "COLORS_PAR_CLOUDFLARE_API_TOKEN"
                  "COLORS_PAR_SIGNOZ_ROOT_PASSWORD"
                  "COLORS_PAR_SIGNOZ_BACKUP_R2_ACCESS_KEY_ID"
                  "COLORS_PAR_SIGNOZ_BACKUP_R2_SECRET_ACCESS_KEY"]]
      (is (str/includes? errors name) name))
    ;; Both are generated on the server and never supplied by the operator.
    (is (not (str/includes? errors "INGEST")))
    (is (not (str/includes? errors "POSTGRES")))))

(deftest a-delete-asks-only-for-the-providers
  ;; Destroying a machine must not require the credentials needed to converge
  ;; one; a missing root password should not be a lock on the exit.
  (let [errors (str/join "\n" (validate/secret-errors (fixture) :delete))]
    (is (str/includes? errors "COLORS_PAR_VULTR_API_KEY"))
    (is (not (str/includes? errors "COLORS_PAR_SIGNOZ_ROOT_PASSWORD")))
    (is (not (str/includes? errors "BACKUP")))))
