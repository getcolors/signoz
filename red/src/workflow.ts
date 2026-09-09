import { readPars, parName } from "red/cli";
import * as dryRun from "red/dry-run";
import { preflight, type PreflightContext } from "red/lifecycle";
import * as progress from "red/progress";
import * as tofu from "red/tofu";
import { adviceAdd, failed, workflow, type Opts, type WireDecl } from "red/workflow";
import * as compute from "./compute.ts";
import * as ssh from "./ssh.ts";
import * as sshConfig from "./ssh-config.ts";
import * as tools from "./tools.ts";
import * as validate from "./validate.ts";

export const defaults: Opts = {
  "provider-compute": validate.defaultComputeProvider, "provider-dns": "cloudflare",
  "provider-backend": "r2", "compute-prevent-destroy": true,
  workdir: ".colors",
};

export async function startStep(opts:Opts,env:Record<string,string|undefined>=process.env):Promise<Opts>{return preflight(opts,{defaults,overlay:readPars,validators:[(_o,e)=>validate.envErrors(e),o=>validate.stateErrors(o),(o,_e,c)=>c.real&&['create','delete'].includes(c.event??'')?validate.secretErrors(o,c.event??""):[],(o,_e,c)=>c.real&&c.event==='delete'&&o['compute-prevent-destroy']?['compute destruction is protected; set COLORS_PAR_COMPUTE_PREVENT_DESTROY=false to delete']:[]],afterValidate:async(o,e,c)=>{if(c.real&&c.event==='delete')return compute.load(o,e);if(c.real&&c.event==='create')return sshConfig.preflight(o);return {...ssh.withMachineKey(o),'red/exit':0};}},env);}

export function wireFn(step: string, runOpts: Opts): WireDecl | undefined {
  if (runOpts["red/event"] === "delete") {
    const graph: Record<string, WireDecl> = {
      "signoz/start": [startStep, "signoz/ansible"],
      "signoz/ansible": [tools.ansibleStep, "signoz/dns"],
      // The `~/.ssh/config` block goes before the destroy, the opposite of the
      // keypair below. A block that outlives its host is stale but harmless; a
      // key that predeceases its host locks the operator out of a machine that
      // still exists. Both orders are deliberate; see standards/ssh-config.md.
      "signoz/dns": [tools.dnsStep, "signoz/ssh-config"],
      "signoz/ssh-config": [tools.ansibleLocalStep, "signoz/infrastructure"],
      "signoz/infrastructure": [tools.infrastructureStep],
    };
    return graph[step];
  }
  const graph: Record<string, WireDecl> = {
    "signoz/start": [startStep, "signoz/infrastructure"],
    // After compute, which is where the address first exists, and before the
    // stage that converges the machine.
    "signoz/infrastructure": [tools.infrastructureStep, "signoz/ssh-config"],
    "signoz/ssh-config": [tools.ansibleLocalStep, "signoz/dns"],
    "signoz/dns": [tools.dnsStep, "signoz/ansible"],
    "signoz/ansible": [tools.ansibleStep, "signoz/acceptance"],
    "signoz/acceptance": [tools.acceptanceStep],
  };
  return graph[step];
}

export function backendAdvice(tool: string) {
  return tofu.conventionalBackendAdvice({
    dir: (opts) => tools.toolDir(opts, tool),
    key: (opts) => `${opts.profile ?? ""}/${tool}.tfstate`,
  });
}

export const sideEffecting = [
  "signoz/infrastructure", "signoz/dns", "signoz/ssh-config",
  "signoz/ansible", "signoz/acceptance",
];

function create() {
  let wf = workflow({ start: "signoz/start", wireFn, nextFn:(_step, successors, opts)=>opts["signoz/already-destroyed"]||failed(opts)?[]:(successors??[]).map(step=>[step,opts]) });
  wf = adviceAdd(wf, "signoz/dns", "before", "signoz.workflow/backend",
    backendAdvice(tools.dnsTool));
  return dryRun.advise(progress.advise(wf), sideEffecting);
}

export const signozWorkflow = create();
