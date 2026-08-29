"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.linkInstalledDependencies = linkInstalledDependencies;
exports.runMutationCheck = runMutationCheck;
exports.runSimulation = runSimulation;
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
    if (options.live && options.simulated)
        throw new Error("Choose either --live or --simulated, not both.");
    if (!options.live && !options.simulated) {
        process.stdout.write(`${JSON.stringify({ mode: "dry-run", cases: selectedCases.map((evaluationCase) => evaluationCase.id), strategies: ["single-model", "fixed-roles"], iterations: options.iterations, plannedRuns: selectedCases.length * 2 * options.iterations, message: "No Codex turn, validation command, worktree, or result file was created. Re-run with --simulated for an offline worktree evaluation or --live to consume Codex allowance." }, null, 2)}\n`);
        return;
    }
    if (options.live) {
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
    }
    const executionBackend = options.simulated ? "simulated" : "codex";
    const runs = [];
    for (const evaluationCase of selectedCases) {
        for (let iteration = 1; iteration <= options.iterations; iteration++) {
            for (const strategy of ["single-model", "fixed-roles"]) {
                runs.push(await runEvaluation(manifest, evaluationCase, strategy, options.ref, iteration, executionBackend));
            }
        }
    }
    const report = { version: 2, generatedAt: new Date().toISOString(), ref: options.ref, executionBackend, runs, summary: (0, evaluation_1.summariseEvaluationRuns)(runs) };
    await node_fs_1.promises.mkdir(options.resultsDirectory, { recursive: true });
    const resultPath = (0, node_path_1.join)(options.resultsDirectory, `baseline-${report.generatedAt.replace(/[:.]/g, "-")}.json`);
    await node_fs_1.promises.writeFile(resultPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ resultPath, executionBackend, summary: report.summary }, null, 2)}\n`);
}
async function runEvaluation(manifest, evaluationCase, strategy, ref, iteration, executionBackend) {
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
        const execution = executionBackend === "codex"
            ? await runCodex(["exec", "--ephemeral", "-C", directory, "-m", allocation.model, "-c", `model_reasoning_effort=${JSON.stringify(allocation.effort)}`, "-s", "workspace-write", (0, evaluation_1.buildPrompt)(strategy, evaluationCase)])
            : await runSimulation(directory, evaluationCase);
        const executionExitCode = execution.exitCode;
        const validationExitCode = executionExitCode === 0 ? await runValidation(directory, evaluationCase) : null;
        const expectationPassed = executionExitCode === 0 ? await matchesExpectation(directory, evaluationCase) : null;
        const changedFiles = (await run("git", ["-C", directory, "diff", "--quiet"], { allowNonZero: true, suppressOutput: true })) !== 0;
        const mutationKilled = executionExitCode === 0 && validationExitCode === 0 && expectationPassed !== false ? await runMutationCheck(directory, evaluationCase) : null;
        return {
            caseId: evaluationCase.id,
            iteration,
            strategy,
            executionBackend,
            allocations: strategy === "single-model" ? { singleModel: manifest.singleModel } : {
                parent: manifest.fixedRoles.parent,
                explorer: manifest.fixedRoles.explorer,
                worker: manifest.fixedRoles.worker,
                reviewer: manifest.fixedRoles.reviewer
            },
            durationMs: Date.now() - startedAt,
            executionExitCode,
            validationExitCode,
            expectationPassed,
            mutationKilled,
            changedFiles,
            completedAt: new Date().toISOString(),
            failureKind: executionExitCode === 0 ? undefined : executionBackend === "simulated" ? "simulation" : (0, evaluation_1.classifyCodexFailure)(execution.stderr, executionExitCode)
        };
    }
    finally {
        await run("git", ["worktree", "remove", "--force", directory], { allowNonZero: true, suppressOutput: true });
    }
}
async function runValidation(directory, evaluationCase) {
    await linkInstalledDependencies(directory);
    return run(evaluationCase.validation.command, evaluationCase.validation.args, { cwd: directory, allowNonZero: true, suppressOutput: true });
}
async function linkInstalledDependencies(directory) {
    const source = (0, node_path_1.resolve)("node_modules");
    let sourceStats;
    try {
        sourceStats = await node_fs_1.promises.stat(source);
    }
    catch {
        throw new Error("Baseline evaluation requires installed local dependencies in node_modules. Run npm install in the launch workspace first.");
    }
    if (!sourceStats.isDirectory())
        throw new Error("Baseline evaluation requires node_modules to be a directory.");
    await node_fs_1.promises.symlink(source, (0, node_path_1.join)(directory, "node_modules"), process.platform === "win32" ? "junction" : "dir");
}
async function matchesExpectation(directory, evaluationCase) {
    if (!evaluationCase.expectation)
        return null;
    const target = (0, node_path_1.resolve)(directory, evaluationCase.expectation.file);
    if ((0, node_path_1.relative)(directory, target).startsWith(".."))
        return false;
    const diff = await runCapture("git", ["-C", directory, "diff", "--", evaluationCase.expectation.file]);
    return evaluationCase.expectation.requiredPatterns.every((pattern) => diff.includes(pattern));
}
async function runMutationCheck(directory, evaluationCase) {
    if (!evaluationCase.mutation)
        return null;
    const target = (0, node_path_1.resolve)(directory, evaluationCase.mutation.file);
    if ((0, node_path_1.relative)(directory, target).startsWith(".."))
        return false;
    let original;
    try {
        original = await node_fs_1.promises.readFile(target, "utf8");
    }
    catch {
        return false;
    }
    if (!original.includes(evaluationCase.mutation.search))
        return false;
    const mutated = original.replace(evaluationCase.mutation.search, evaluationCase.mutation.replacement);
    try {
        await node_fs_1.promises.writeFile(target, mutated, "utf8");
        return (await run(evaluationCase.mutation.validation.command, evaluationCase.mutation.validation.args, { cwd: directory, allowNonZero: true, suppressOutput: true })) !== 0;
    }
    finally {
        await node_fs_1.promises.writeFile(target, original, "utf8");
    }
}
async function runSimulation(directory, evaluationCase) {
    if (!evaluationCase.simulation)
        return { exitCode: 1, stderr: "" };
    const target = (0, node_path_1.resolve)(directory, evaluationCase.simulation.file);
    if ((0, node_path_1.relative)(directory, target).startsWith(".."))
        return { exitCode: 1, stderr: "" };
    let original;
    try {
        original = await node_fs_1.promises.readFile(target, "utf8");
    }
    catch {
        return { exitCode: 1, stderr: "" };
    }
    if (!original.includes(evaluationCase.simulation.search))
        return { exitCode: 1, stderr: "" };
    await node_fs_1.promises.writeFile(target, original.replace(evaluationCase.simulation.search, evaluationCase.simulation.replacement), "utf8");
    return { exitCode: 0, stderr: "" };
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
async function runCapture(command, args) {
    return new Promise((resolvePromise, reject) => {
        const child = (0, node_child_process_1.spawn)(command, args, { shell: false, stdio: ["ignore", "pipe", "ignore"] });
        let stdout = "";
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk) => { stdout += chunk; });
        child.on("error", reject);
        child.on("exit", (code) => code === 0 ? resolvePromise(stdout) : reject(new Error(`${command} exited with status ${code ?? 1}.`)));
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
    const options = { live: false, simulated: false, manifestPath: (0, node_path_1.resolve)("evals/baseline-manifest.json"), resultsDirectory: (0, node_path_1.resolve)("evals/results"), ref: "HEAD", iterations: 1 };
    for (let index = 0; index < argumentsList.length; index++) {
        const argument = argumentsList[index];
        if (argument === "--live")
            options.live = true;
        else if (argument === "--simulated")
            options.simulated = true;
        else if (argument === "--manifest")
            options.manifestPath = (0, node_path_1.resolve)(requiredValue(argumentsList, ++index, argument));
        else if (argument === "--results-dir")
            options.resultsDirectory = (0, node_path_1.resolve)(requiredValue(argumentsList, ++index, argument));
        else if (argument === "--ref")
            options.ref = requiredValue(argumentsList, ++index, argument);
        else if (argument === "--case")
            options.caseId = requiredValue(argumentsList, ++index, argument);
        else if (argument === "--iterations")
            options.iterations = positiveInteger(requiredValue(argumentsList, ++index, argument), argument);
        else
            throw new Error(`Unknown argument: ${argument}.`);
    }
    return options;
}
function positiveInteger(value, option) {
    if (!/^\d+$/.test(value) || Number(value) < 1)
        throw new Error(`${option} requires a positive integer.`);
    return Number(value);
}
function requiredValue(argumentsList, index, option) {
    const value = argumentsList[index];
    if (!value || value.startsWith("--"))
        throw new Error(`${option} requires a value.`);
    return value;
}
if (require.main === module) {
    void main().catch((error) => {
        const message = error instanceof Error ? error.message : "Unknown baseline evaluation failure.";
        process.stderr.write(`Baseline evaluation failed: ${message}\n`);
        process.exitCode = 1;
    });
}
//# sourceMappingURL=baseline-eval.js.map