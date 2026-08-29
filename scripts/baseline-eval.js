"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const promises_1 = require("node:fs/promises");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const appServer_1 = require("../src/appServer");
const evaluation_1 = require("../src/evaluation");
async function main() {
    const options = parseArguments(process.argv.slice(2));
    const manifest = await readManifest(options.manifestPath);
    const selectedCases = options.caseId ? manifest.cases.filter((evaluationCase) => evaluationCase.id === options.caseId) : manifest.cases;
    if (options.caseId && selectedCases.length === 0)
        throw new Error(`No evaluation case exists with ID ${options.caseId}.`);
    if (!options.live) {
        process.stdout.write(`${JSON.stringify({ mode: "dry-run", cases: selectedCases.map((evaluationCase) => evaluationCase.id), strategies: ["single-model", "fixed-roles"], message: "No Codex turn, validation command, worktree, or result file was created. Re-run with --live to consume Codex allowance." }, null, 2)}\n`);
        return;
    }
    const server = new appServer_1.CodexAppServer();
    try {
        const status = await server.start();
        if (!(0, appServer_1.isChatGPTAuthentication)(status.authMethod))
            throw new Error("Live baseline evaluation requires existing ChatGPT authentication.");
        const allocationErrors = (0, evaluation_1.validateAllocations)(manifest, status.models);
        if (allocationErrors.length > 0)
            throw new Error(`Live catalogue validation failed:\n${allocationErrors.join("\n")}`);
    }
    finally {
        server.dispose();
    }
    const runs = [];
    for (const evaluationCase of selectedCases) {
        for (const strategy of ["single-model", "fixed-roles"]) {
            runs.push(await runEvaluation(manifest, evaluationCase, strategy, options.ref));
        }
    }
    const report = { version: 1, generatedAt: new Date().toISOString(), ref: options.ref, runs, summary: (0, evaluation_1.summariseEvaluationRuns)(runs) };
    await node_fs_1.promises.mkdir(options.resultsDirectory, { recursive: true });
    const resultPath = (0, node_path_1.join)(options.resultsDirectory, `baseline-${report.generatedAt.replace(/[:.]/g, "-")}.json`);
    await node_fs_1.promises.writeFile(resultPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ resultPath, summary: report.summary }, null, 2)}\n`);
}
async function runEvaluation(manifest, evaluationCase, strategy, ref) {
    const directory = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "codex-router-baseline-"));
    try {
        await run("git", ["worktree", "add", "--detach", directory, ref]);
        if (strategy === "fixed-roles") {
            const agentsDirectory = (0, node_path_1.join)(directory, ".codex", "agents");
            await node_fs_1.promises.mkdir(agentsDirectory, { recursive: true });
            await Promise.all(Object.entries((0, evaluation_1.roleAgentFiles)(manifest.fixedRoles)).map(([name, content]) => node_fs_1.promises.writeFile((0, node_path_1.join)(agentsDirectory, name), content, { encoding: "utf8", mode: 0o600 })));
        }
        const allocation = strategy === "single-model" ? manifest.singleModel : manifest.fixedRoles.parent;
        const startedAt = Date.now();
        const codex = await runCodex(["exec", "--ephemeral", "-C", directory, "-m", allocation.model, "-c", `model_reasoning_effort=${JSON.stringify(allocation.effort)}`, "-s", "workspace-write", (0, evaluation_1.buildPrompt)(strategy, evaluationCase)]);
        const codexExitCode = codex.exitCode;
        const validationExitCode = codexExitCode === 0 ? await run(evaluationCase.validation.command, evaluationCase.validation.args, { cwd: directory, suppressOutput: true }) : null;
        const changedFiles = (await run("git", ["-C", directory, "diff", "--quiet"], { allowNonZero: true, suppressOutput: true })) !== 0;
        return {
            caseId: evaluationCase.id,
            strategy,
            allocations: strategy === "single-model" ? { singleModel: manifest.singleModel } : {
                parent: manifest.fixedRoles.parent,
                explorer: manifest.fixedRoles.explorer,
                worker: manifest.fixedRoles.worker,
                reviewer: manifest.fixedRoles.reviewer
            },
            durationMs: Date.now() - startedAt,
            codexExitCode,
            validationExitCode,
            changedFiles,
            completedAt: new Date().toISOString(),
            failureKind: codexExitCode === 0 ? undefined : (0, evaluation_1.classifyCodexFailure)(codex.stderr, codexExitCode)
        };
    }
    finally {
        await run("git", ["worktree", "remove", "--force", directory], { allowNonZero: true, suppressOutput: true });
    }
}
async function runCodex(args) {
    return new Promise((resolvePromise, reject) => {
        const child = (0, node_child_process_1.spawn)("codex", args, { shell: false, stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4096); });
        child.on("error", reject);
        child.on("exit", (code) => resolvePromise({ exitCode: code ?? 1, stderr }));
    });
}
async function readManifest(path) {
    const content = await node_fs_1.promises.readFile(path, "utf8");
    const value = JSON.parse(content);
    const errors = (0, evaluation_1.validateEvaluationManifest)(value);
    if (errors.length > 0)
        throw new Error(`Invalid evaluation manifest:\n${errors.join("\n")}`);
    return value;
}
async function run(command, args, options = {}) {
    return new Promise((resolvePromise, reject) => {
        const child = (0, node_child_process_1.spawn)(command, args, { cwd: options.cwd, shell: false, stdio: options.suppressOutput ? "ignore" : "inherit" });
        child.on("error", reject);
        child.on("exit", (code) => {
            const exitCode = code ?? 1;
            if (exitCode !== 0 && !options.allowNonZero)
                reject(new Error(`${command} exited with status ${exitCode}.`));
            else
                resolvePromise(exitCode);
        });
    });
}
function parseArguments(argumentsList) {
    const options = { live: false, manifestPath: (0, node_path_1.resolve)("evals/baseline-manifest.json"), resultsDirectory: (0, node_path_1.resolve)("evals/results"), ref: "HEAD" };
    for (let index = 0; index < argumentsList.length; index++) {
        const argument = argumentsList[index];
        if (argument === "--live")
            options.live = true;
        else if (argument === "--manifest")
            options.manifestPath = (0, node_path_1.resolve)(requiredValue(argumentsList, ++index, argument));
        else if (argument === "--results-dir")
            options.resultsDirectory = (0, node_path_1.resolve)(requiredValue(argumentsList, ++index, argument));
        else if (argument === "--ref")
            options.ref = requiredValue(argumentsList, ++index, argument);
        else if (argument === "--case")
            options.caseId = requiredValue(argumentsList, ++index, argument);
        else
            throw new Error(`Unknown argument: ${argument}.`);
    }
    return options;
}
function requiredValue(argumentsList, index, option) {
    const value = argumentsList[index];
    if (!value || value.startsWith("--"))
        throw new Error(`${option} requires a value.`);
    return value;
}
void main().catch((error) => {
    const message = error instanceof Error ? error.message : "Unknown baseline evaluation failure.";
    process.stderr.write(`Baseline evaluation failed: ${message}\n`);
    process.exitCode = 1;
});
//# sourceMappingURL=baseline-eval.js.map
