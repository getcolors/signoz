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

;; --- the compute-provider registry

(deftest unsupported-provider-names-the-advertised-ones
  (is (some #{":provider-compute must be one of digitalocean, vultr"}
            (validate/state-errors (fixture :provider-compute "hetzner")))))

(deftest required-keys-follow-the-selected-provider
  (is (some #{":digitalocean-size is required"}
            (validate/state-errors (do-fixture :digitalocean-size nil))))
  (is (some #{":vultr-plan is required"}
            (validate/state-errors (fixture :vultr-plan nil))))
  ;; The other provider's keys are neither required nor refused, so one
  ;; colors.yml can carry both and move between providers by one edit.
  (is (not-any? #(str/includes? % "vultr") (validate/state-errors (do-fixture))))
  (is (= [] (validate/state-errors (fixture :digitalocean-region "ams3"
                                            :digitalocean-size "s-1vcpu-1gb"))))
  (is (= [] (validate/state-errors (do-fixture :vultr-os-id "not-checked-here")))))

(deftest name-and-machine-key-are-never-required
  ;; Compute Name Standard: the profile is the default. SSH Keypair Standard:
  ;; absence selects keygen mode.
  (doseq [errors [(validate/state-errors (fixture :vultr-name nil))
                  (validate/state-errors (do-fixture))]]
    (is (not-any? #(str/includes? % "-name") errors))
    (is (not-any? #(str/includes? % "-ssh-keys") errors))))

(deftest vultr-os-id-is-checked-on-vultr-only
  (is (some #{":vultr-os-id must be Vultr's numeric operating-system id"}
            (validate/state-errors (fixture :vultr-os-id "2284"))))
  (is (= [] (validate/state-errors (do-fixture :vultr-os-id "2284")))))

(deftest digitalocean-refuses-a-pinned-or-created-vpc
  (let [errors (validate/state-errors (do-fixture :digitalocean-vpc-uuid "abc"
                                                  :digitalocean-vpc-cidr "10.0.0.0/16"))]
    (is (some #(str/starts-with? % ":digitalocean-vpc-uuid must be absent") errors))
    (is (some #(str/starts-with? % ":digitalocean-vpc-cidr must be absent") errors)))
  ;; An unselected provider's keys are ignored, VPC keys included.
  (is (= [] (validate/state-errors (fixture :digitalocean-vpc-uuid "abc")))))

;; --- the compute name

(deftest compute-name-falls-back-to-the-profile
  (is (= "signoz-digitalocean-fixture" (validate/compute-name (do-fixture))))
  (is (= "signoz-digitalocean-optout" (validate/compute-name (do-optout))))
  (is (= "signoz-fixture" (validate/compute-name (fixture :vultr-name nil))))
  (is (= "signoz-fixture" (validate/compute-name (fixture :vultr-name ""))))
  (is (= "signoz-fixture" (validate/compute-name (fixture :vultr-name "REPLACE_ME"))))
  (is (= "custom-label" (validate/compute-name (fixture :vultr-name "custom-label"))))
  ;; The override is read from the selected provider's key alone.
  (is (= "signoz-digitalocean-fixture"
         (validate/compute-name (do-fixture :vultr-name "custom-label")))))

(deftest the-name-override-is-validated-against-the-providers-rules
  (is (some #{":vultr-name must be a safe 1-63 character name"}
            (validate/state-errors (fixture :vultr-name "no spaces!"))))
  (is (some #{":vultr-name must be a safe 1-63 character name"}
            (validate/state-errors (fixture :vultr-name (apply str (repeat 64 "a"))))))
  ;; Vultr labels are console text; DigitalOcean droplet names are hostnames,
  ;; so an underscore that Vultr accepts fails at DigitalOcean.
  (is (= [] (validate/state-errors (fixture :vultr-name "invalid_name"))))
  (let [err ":digitalocean-name must be a hostname-like name: lowercase letters, digits, dots and hyphens, 1-63 characters"]
    (is (some #{err} (validate/state-errors (do-fixture :digitalocean-name "invalid_name"))))
    (is (some #{err} (validate/state-errors (do-fixture :digitalocean-name "Upper"))))
    (is (some #{err} (validate/state-errors (do-fixture :digitalocean-name "-leading"))))
    (is (some #{err} (validate/state-errors (do-fixture :digitalocean-name (apply str (repeat 64 "a"))))))
    (is (= [] (validate/state-errors (do-fixture :digitalocean-name "sig.noz-01"))))))

(deftest the-resolved-name-is-validated-when-it-falls-back-to-the-profile
  ;; The profile reaches the provider as the machine name whenever no override
  ;; is set, so it is held to the same rule and the error names the profile.
  (let [errors (validate/state-errors (do-fixture :profile "Prod_Name"))]
    (is (some #{":profile (the digitalocean machine name) must be a hostname-like name: lowercase letters, digits, dots and hyphens, 1-63 characters"}
              errors))
    (is (not-any? #(str/includes? % ":digitalocean-name") errors)))
  ;; Vultr's rule allows the same profile.
  (is (= [] (validate/state-errors (fixture :profile "Prod_Name" :vultr-name nil))))
  ;; A valid override shadows an invalid profile; an invalid override is the
  ;; override's error, not the profile's.
  (is (= [] (validate/state-errors (do-fixture :profile "Prod_Name" :digitalocean-name "prod"))))
  (is (some #(str/starts-with? % ":digitalocean-name must be")
            (validate/state-errors (do-fixture :profile "Prod_Name" :digitalocean-name "Bad_One"))))
  ;; A missing profile is the required-key error alone, not a name error too.
  (is (not-any? #(str/includes? % "hostname-like")
                (validate/state-errors (do-fixture :profile nil)))))

(deftest compute-key-is-provider-scoped
  (is (= :vultr-ssh-sources (validate/compute-key (fixture) "ssh-sources")))
  (is (= :digitalocean-http-sources (validate/compute-key (do-fixture) "http-sources"))))

;; --- the network contract

(deftest cidr-syntax
  (doseq [ok ["0.0.0.0/0" "10.0.0.0/8" "203.0.113.7/32" "::/0" "2001:db8::/32"
              "fe80::1/128" "2001:db8:0:0:0:0:0:1/64"
              ;; IPv4-embedded tails occupy the last two groups.
              "::ffff:192.0.2.1/128" "64:ff9b::192.0.2.33/96" "1:2:3:4:5:6:192.0.2.1/128"]]
    (is (validate/cidr? ok) ok))
  (doseq [bad ["10.0.0.0" "10.0.0.256/8" "10.0.0.0/33" "2001:db8::/129" "example.com/24"
               "1:::2/64" "2001:db8::1::2/64" "1:2:3:4:5:6:7:8:9/64" "" "/24" "10.0.0.0/8/8"
               ;; A malformed or misplaced dotted-quad tail.
               "::ffff:192.0.2.256/128" "::ffff:192.0.2/128" "1:2:3:4:5:6:7:192.0.2.1/128"
               "192.0.2.1::/64" "::ffff:192.0.2.1:1/128"]]
    (is (not (validate/cidr? bad)) bad)))

(deftest ssh-sources-must-not-be-empty
  (is (some #{":vultr-ssh-sources must list at least one CIDR"}
            (validate/state-errors (fixture :vultr-ssh-sources []))))
  (is (some #{":digitalocean-ssh-sources must list at least one CIDR"}
            (validate/state-errors (do-fixture :digitalocean-ssh-sources " , "))))
  ;; No public HTTP is a legitimate deployment.
  (is (= [] (validate/state-errors (fixture :vultr-http-sources []))))
  (is (= [] (validate/state-errors (do-fixture :digitalocean-http-sources [])))))

(deftest malformed-sources-are-refused-before-any-provider-call
  (is (some #{":vultr-http-sources entry \"10.0.0.0\" is not an IPv4 or IPv6 CIDR"}
            (validate/state-errors (fixture :vultr-http-sources ["0.0.0.0/0" "10.0.0.0"]))))
  (is (some #{":digitalocean-ssh-sources entry \"office.example.com/32\" is not an IPv4 or IPv6 CIDR"}
            (validate/state-errors (do-fixture :digitalocean-ssh-sources "office.example.com/32"))))
  ;; Only the selected provider's lists are checked.
  (is (= [] (validate/state-errors (do-fixture :vultr-ssh-sources ["garbage"])))))

;; --- provider switching is a rebuild

(deftest provider-state-is-compared-with-the-selection
  (is (nil? (validate/provider-state-errors (fixture) nil)))
  (is (nil? (validate/provider-state-errors (fixture) {:provider "vultr" :ip "203.0.113.9"})))
  (is (nil? (validate/provider-state-errors (do-fixture) {:provider "digitalocean"})))
  (is (= ["state holds a digitalocean machine; set provider-compute back to digitalocean and delete first"]
         (validate/provider-state-errors (fixture) {:provider "digitalocean" :ip "203.0.113.9"})))
  (is (= ["state holds a vultr machine; set provider-compute back to vultr and delete first"]
         (validate/provider-state-errors (do-fixture) {:provider "vultr"}))))

(deftest legacy-state-without-a-provider-is-the-default-providers
  ;; Every deployment created before adoption recorded no provider and runs
  ;; the only provider the package ever offered.
  (is (nil? (validate/provider-state-errors (fixture) {:ip "203.0.113.9"})))
  (let [[err] (validate/provider-state-errors (do-fixture) {:ip "203.0.113.9"})]
    (is (str/includes? err "no recorded provider"))
    (is (str/includes? err "set provider-compute back to vultr and delete first"))))

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
    (doseq [part ["host" "image" "root-email" "provider-dns" "provider-compute"
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
    (is (not (str/includes? errors "POSTGRES")))
    (is (not (str/includes? errors "COLORS_PAR_DO_TOKEN")))))

(deftest secrets-and-tofu-env-follow-the-selected-provider
  (let [errors (str/join "\n" (validate/secret-errors (do-fixture) :create))]
    (is (str/includes? errors "COLORS_PAR_DO_TOKEN"))
    (is (str/includes? errors "COLORS_PAR_CLOUDFLARE_API_TOKEN"))
    (is (str/includes? errors "COLORS_PAR_SIGNOZ_ROOT_PASSWORD"))
    (is (not (str/includes? errors "COLORS_PAR_VULTR_API_KEY"))))
  (let [errors (str/join "\n" (validate/secret-errors (do-fixture) :delete))]
    (is (str/includes? errors "COLORS_PAR_DO_TOKEN"))
    (is (not (str/includes? errors "COLORS_PAR_SIGNOZ_ROOT_PASSWORD"))))
  (is (= {:do-token "DIGITALOCEAN_TOKEN"} (validate/tofu-env (do-fixture) :provider-compute)))
  (is (= {:vultr-api-key "VULTR_API_KEY"} (validate/tofu-env (fixture) :provider-compute)))
  (is (= {} (validate/tofu-env (fixture :provider-compute "hetzner") :provider-compute))))

(deftest a-delete-asks-only-for-the-providers
  ;; Destroying a machine must not require the credentials needed to converge
  ;; one; a missing root password should not be a lock on the exit.
  (let [errors (str/join "\n" (validate/secret-errors (fixture) :delete))]
    (is (str/includes? errors "COLORS_PAR_VULTR_API_KEY"))
    (is (not (str/includes? errors "COLORS_PAR_SIGNOZ_ROOT_PASSWORD")))
    (is (not (str/includes? errors "BACKUP")))))
