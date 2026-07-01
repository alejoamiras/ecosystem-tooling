// Export the base class and types for users

export type { FeeGasSettings, FeeOptions } from './feeWrappedInteraction.js';
// Export fee payment helpers
export { FeeWrappedInteraction, namedMethod } from './feeWrappedInteraction.js';
// Also export the Profiler for potential advanced use (or internal use by CLI)
export { Profiler } from './profiler.js';
// Export system info utilities
export { getSystemInfo } from './systemInfo.js';
export type { GateCount, NamedBenchmarkedInteraction, ProfileReport, ProfileResult, SystemInfo } from './types.js';
export { BenchmarkBase as Benchmark, BenchmarkContext } from './types.js'; // Alias BenchmarkBase to Benchmark for user convenience
