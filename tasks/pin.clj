(ns pin (:require [clojure.java.shell :as sh] [clojure.string :as str]))
(def path "skills/package-signoz-green/green")
(def rx #"\(def \^:private signoz-sha (nil|\"[0-9a-f]{40}\")\)")
(defn git [& args] (let [{:keys [exit out]} (apply sh/sh "git" args)] (when (zero? exit) (str/trim out))))
(let [dirty (git "status" "--porcelain") sha (git "rev-parse" "HEAD") remotes (git "branch" "-r" "--contains" sha)]
  (cond (seq dirty) (do (binding [*out* *err*] (println "signoz working tree is dirty; commit before pinning")) (System/exit 2))
        (not (str/includes? (str remotes) "origin/")) (do (binding [*out* *err*] (println "signoz HEAD is not pushed")) (System/exit 2))
        :else (let [s (slurp path) n (str/replace s rx (str "(def ^:private signoz-sha \"" sha "\")"))]
                (spit path n) (println "pinned signoz launcher to" (subs sha 0 7)))))
