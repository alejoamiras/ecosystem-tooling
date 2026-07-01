// Export the base class and types for users
export { BenchmarkBase as Benchmark, BenchmarkContext } from './types.js'; // Alias BenchmarkBase to Benchmark for user convenience
export type { ProfileReport, ProfileResult, GateCount, SystemInfo, NamedBenchmarkedInteraction } from './types.js';

// Export system info utilities
export { getSystemInfo } from './systemInfo.js';

// Also export the Profiler for potential advanced use (or internal use by CLI)
export { Profiler } from './profiler.js';

// Export fee payment helpers
export { FeeWrappedInteraction, namedMethod } from './feeWrappedInteraction.js';
export type { FeeGasSettings, FeeOptions } from './feeWrappedInteraction.js';
