(ns io.github.getcolors.signoz.ssh-test
 (:require [clojure.test :refer [deftest is]]
 [io.github.getcolors.signoz.ssh :as ssh]
 [io.github.getcolors.signoz.validate-test :refer [fixture optout]]))
(deftest build-managed-identity
 (is (= "/home/build-placeholder/.ssh/signoz-fixture" (:ssh-private-key-path (ssh/with-machine-key (fixture :green/event :build))))))
(deftest external-identity-preserved
 (is (= (optout) (ssh/with-machine-key (optout))))
 (is (= "/home/build-placeholder/.ssh/operator-key" (second (ssh/identity-args (optout))))))
(deftest no-application-key-generation
 (is (= (fixture) (ssh/with-machine-key (fixture)))))
