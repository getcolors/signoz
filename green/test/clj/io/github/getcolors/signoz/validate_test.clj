(ns io.github.getcolors.signoz.validate-test
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is]]
            [green.cli :as green-cli]
            [io.github.getcolors.signoz.validate :as validate]))

(def fixture-file "test/fixtures/colors.yml")
(def optout-file "test/fixtures/optout.yml")
(def do-fixture-file "test/fixtures/colors-digitalocean.yml")
(def do-optout-file "test/fixtures/optout-digitalocean.yml")

(defn- read-fixture [path overrides]
  (merge (green-cli/read-state path (str/replace (slurp path) "WORKDIR" ".colors"))
         overrides))
(defn fixture [& {:as overrides}] (read-fixture fixture-file overrides))
(defn optout [& {:as overrides}] (read-fixture optout-file overrides))
(defn do-fixture [& {:as overrides}] (read-fixture do-fixture-file overrides))
(defn do-optout [& {:as overrides}] (read-fixture do-optout-file overrides))

(deftest fixture-is-valid (is (= [] (validate/state-errors (fixture)))))

(deftest optout-fixture-is-valid (is (= [] (validate/state-errors (optout)))))

(deftest digitalocean-fixtures-are-valid
  (is (= [] (validate/state-errors (do-fixture))))
  (is (= [] (validate/state-errors (do-optout)))))

;; --- the spec handed to ONCE

(deftest name-and-machine-key-are-never-required
  ;; Compute Name Standard: the profile is the default. SSH Keypair Standard:
  ;; absence selects keygen mode.
  (doseq [errors [(validate/state-errors (fixture :vultr-name nil))
                  (validate/state-errors (do-fixture))]]
    (is (not-any? #(str/includes? % "-name") errors))
    (is (not-any? #(str/includes? % "-ssh-keys") errors))))

;; --- the compute name

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
                         :provider-dns "other" :provider-compute "hetzner"
                         :signoz-backup-retention-days 0
                         :signoz-backup-dir "relative/path"))]
    (is (<= 7 (count errors)))
    (doseq [part ["host" "image" "root-email" "provider-dns" "compute deployment"
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
    (doseq [name ["COLORS_PAR_CLOUDFLARE_API_TOKEN"
                  "COLORS_PAR_SIGNOZ_ROOT_PASSWORD"
                  "COLORS_PAR_SIGNOZ_BACKUP_R2_ACCESS_KEY_ID"
                  "COLORS_PAR_SIGNOZ_BACKUP_R2_SECRET_ACCESS_KEY"]]
      (is (str/includes? errors name) name))
    ;; Both are generated on the server and never supplied by the operator.
    (is (not (str/includes? errors "INGEST")))
    (is (not (str/includes? errors "POSTGRES")))
    (is (not (str/includes? errors "COLORS_PAR_DO_TOKEN")))))

(deftest a-delete-asks-only-for-the-providers
  ;; Destroying a machine must not require the credentials needed to converge
  ;; one; a missing root password should not be a lock on the exit.
  (let [errors (str/join "\n" (validate/secret-errors (fixture) :delete))]
    (is (str/includes? errors "COLORS_PAR_CLOUDFLARE_API_TOKEN"))
    (is (not (str/includes? errors "COLORS_PAR_SIGNOZ_ROOT_PASSWORD")))
    (is (not (str/includes? errors "BACKUP")))))
