/**
 * BenchmarkRunner - executes benchmark cases against a pluggable
 * BenchmarkPipelineProvider and produces BenchmarkScore objects.
 *
 * Designed for both interactive use and CI job execution.
 */
import { scoreBenchmarkRun } from './scorer.js';
// Runner
export class BenchmarkRunner {
    provider;
    constructor(provider) {
        this.provider = provider;
    }
    /**
     * Run a single benchmark case and return its quality score.
     * Never throws - errors in the provider surface as zero scores.
     */
    async runCase(base) {
        let intent = null;
        let pipeline = null;
        try {
            intent = await this.provider.parseIntent(base.message);
        }
        catch {
            // intent remains null - intentAccuracy = 0
        }
        try {
            pipeline = (await this.provider.runPipeline?.(base.message)) ?? null;
        }
        catch {
            // pipeline remains null - hypothesis/conclusion scores = 0
        }
        return scoreBenchmarkRun(base, intent, pipeline);
    }
    /** Run all provided benchmark cases and return their scores. */
    async runAll(cases) {
        const results = [];
        for (const base of cases) {
            results.push(await this.runCase(base));
        }
        return results;
    }
}
/**
 * Run a full CI benchmark pass:
 * 1. Execute all benchmark cases via `runner`.
 * 2. Optionally compare scores against `detector` baseline.
 * 3. Return a DriftReport.
 *
 * For the first run (no baseline yet), the report will have no alerts.
 * Subsequent runs detect degradation once minSamples is reached.
 *
 * @param runner   The BenchmarkRunner to use.
 * @param cases    Benchmark cases to run.
 * @param detector DriftDetector (with pre-loaded historical scores).
 * @returns DriftReport. `passed` is false when any critical alert fires.
 */
export async function runCIBenchmark(runner, cases, detector) {
    const scores = await runner.runAll(cases);
    return detector.generateReport(scores);
}
//# sourceMappingURL=benchmark-runner.js.map
