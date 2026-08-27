(ns io.github.getcolors.signoz.workflow-test
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is]]
            [io.github.getcolors.signoz.validate-test :refer [fixture]]
            [io.github.getcolors.signoz.workflow :as workflow]))

(deftest build-and-dry-run-need-no-credentials
  (is (= 0 (:green/exit (workflow/start-step (assoc (fixture) :green/event :build) {}))))
  (is (= 0 (:green/exit (workflow/start-step
                         (assoc (fixture) :green/event :create :green/dry-run true) {})))))

(deftest build-and-dry-run-never-touch-ssh
  ;; The standard forbids reading, creating, or requiring anything under ~/.ssh
  ;; on a build or dry-run: they render from desired state alone.
  (doseq [opts [(assoc (fixture) :green/event :build)
                (assoc (fixture) :green/event :create :green/dry-run true)]]
    (let [result (workflow/start-step opts {})]
      (is (= 0 (:green/exit result)))
      (is (str/starts-with? (str (:ssh-public-key-path result)) "/home/build-placeholder")
          "a build must not name the operator's home directory"))))

(deftest real-create-requires-credentials
  (let [r (workflow/start-step (assoc (fixture) :green/event :create) {})]
    (is (= 2 (:green/exit r)))
    (is (str/includes? (:green/err r) "COLORS_PAR_VULTR_API_KEY"))
    (is (str/includes? (:green/err r) "COLORS_PAR_CLOUDFLARE_API_TOKEN"))
    (is (str/includes? (:green/err r) "COLORS_PAR_SIGNOZ_ROOT_PASSWORD"))))

(deftest delete-is-protected
  (let [r (workflow/start-step (assoc (fixture) :green/event :delete) {})]
    (is (= 2 (:green/exit r)))
    (is (str/includes? (:green/err r) "COMPUTE_PREVENT_DESTROY"))))

(deftest graph-orders-the-stack
  (is (= [:signoz/infrastructure]
         (vec (rest (workflow/wire-fn :signoz/start {:green/event :create})))))
  (is (= [:signoz/ssh-config]
         (vec (rest (workflow/wire-fn :signoz/infrastructure {:green/event :create})))))
  (is (= [:signoz/dns]
         (vec (rest (workflow/wire-fn :signoz/ssh-config {:green/event :create})))))
  ;; DNS before convergence: Caddy asks Let's Encrypt for a certificate as soon
  ;; as it starts, and that only resolves once the record exists.
  (is (= [:signoz/ansible]
         (vec (rest (workflow/wire-fn :signoz/dns {:green/event :create})))))
  (is (= [:signoz/acceptance]
         (vec (rest (workflow/wire-fn :signoz/ansible {:green/event :create}))))))

(deftest delete-removes-the-key-after-the-compute-destroy
  ;; The ordering is what makes "key present ⇔ deployment exists" hold: a
  ;; failed destroy never reaches the cleanup step, and correctly leaves the
  ;; key that is still the only credential to whatever survived.
  (is (= [:signoz/ansible]
         (vec (rest (workflow/wire-fn :signoz/start {:green/event :delete})))))
  (is (= [:signoz/ssh-cleanup]
         (vec (rest (workflow/wire-fn :signoz/infrastructure {:green/event :delete})))))
  (is (empty? (rest (workflow/wire-fn :signoz/ssh-cleanup {:green/event :delete})))))
