/**
 * BenchmarkRunner - executes benchmark cases against a pluggable
 * BenchmarkPipelineProvider and produces BenchmarkScore objects.
 *
 * Designed for both interactive use and CI job execution.
 */
import type { BenchmarkCase, BenchmarkScore, BenchmarkPipelineProvider, DriftReport } from './types.js';
import type { DriftDetector } from './drift-detector.js';
export declare class BenchmarkRunner {
    private readonly provider;
    constructor(provider: BenchmarkPipelineProvider);
    /**
     * Run a single benchmark case and return its quality score.
     * Never throws - errors in the provider surface as zero scores.
     */
    runCase(base: BenchmarkCase): Promise<BenchmarkScore>;
    /** Run all provided benchmark cases and return their scores. */
    runAll(cases: BenchmarkCase[]): Promise<BenchmarkScore[]>;
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
export declare function runCIBenchmark(runner: BenchmarkRunner, cases: BenchmarkCase[], detector: DriftDetector): Promise<DriftReport>;
//# sourceMappingURL=benchmark-runner.d.ts.map
