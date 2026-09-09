(ns io.github.getcolors.signoz.workflow-test
 (:require [clojure.test :refer [deftest is]]
 [io.github.getcolors.signoz.workflow :as workflow]
 [io.github.getcolors.signoz.compute :as compute]
 [io.github.getcolors.signoz.validate-test :refer [fixture optout do-fixture do-optout]]))
(deftest offline-start
 (doseq [f [fixture optout do-fixture do-optout]]
  (is (= 0 (:green/exit (workflow/start-step (assoc (f) :green/event :build) {}))))))
(deftest singleton-library-contract
 (is (= [{:role nil :count 1}] compute/topology))
 (is (= ["signoz-fixture/signoz-infrastructure.tfstate"] (:legacy_state_keys (compute/requirements (fixture))))))
(deftest errors-and-observed-nodes
 (is (= "legacy compute state requires migration" (:green/err (compute/attach (fixture) {:status "error" :errors ["legacy compute state requires migration"]}))))
 (is (= "ubuntu" (:user (compute/attach (fixture) {:status "present" :cluster {:nodes [{:ip "203.0.113.7" :user "ubuntu"}]}}))))
 (is (:signoz/already-destroyed (compute/attach (fixture) {:status "destroyed"}))))

(deftest library-document-keys-render-deterministically
 (is (= (#'io.github.getcolors.signoz.compute/compute-json {"a" 0 :b 1} 0)
        (#'io.github.getcolors.signoz.compute/compute-json {:a 0 "b" 1} 0))))
