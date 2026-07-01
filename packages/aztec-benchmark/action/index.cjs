const core = require('@actions/core');
const exec = require('@actions/exec');
const fs = require('node:fs');
const path = require('node:path');
const { runComparison } = require('./comparison.cjs');

/**
 * Main function for the GitHub Action.
 * This function is responsible for:
 * - Reading action inputs (threshold, output path, base suffix, current suffix).
 * - Setting up paths and suffixes for benchmark reports.
 * - Executing the benchmark CLI to generate the 'latest' reports.
 * - Running the comparison logic between 'base' and 'latest' reports.
 * - Writing the comparison result to a markdown file.
 * - Setting action outputs (markdown content and file path).
 * It handles errors and sets the action to failed if any step fails.
 */
async function run() {
  try {
    const threshold = parseFloat(core.getInput('threshold'));
    const outputMarkdownPath = core.getInput('output_markdown_path');
    const baseSuffix = core.getInput('base_suffix');
    const currentSuffix = core.getInput('current_suffix');
    const configPath = core.getInput('config_path');
    const reportsDir = core.getInput('reports_dir');
    const onlyReport = core.getInput('only_report') === 'true';
    const circuitDetails = core.getInput('circuit_details') === 'true';

    core.info('--- Inputs ---');
    core.info(`Config Path: ${configPath}`);
    core.info(`Threshold: ${threshold}%`);
    core.info(`Output Markdown Path: ${outputMarkdownPath}`);
    core.info(`Reports Directory: ${reportsDir}`);
    core.info(`Base Suffix: ${baseSuffix}`);
    core.info(`Current Suffix: ${currentSuffix}`);
    core.info(`Only report: ${onlyReport}`);
    core.info(`Circuit details: ${circuitDetails}`);

    if (isNaN(threshold)) {
      throw new Error('Invalid threshold value. Please provide a number.');
    }

    if (!onlyReport) {
      core.startGroup('Generating latest benchmark reports (all contracts)');
      const cliArgs = [];
      cliArgs.push('--config', configPath);
      cliArgs.push('--output-dir', reportsDir);
      cliArgs.push('--suffix', currentSuffix);

      core.info(`Executing: aztec-benchmark ${cliArgs.join(' ')}`);

      const execOptions = {
        cwd: process.cwd()
      };
      const exitCode = await exec.exec('npx aztec-benchmark', cliArgs, execOptions);
      if (exitCode !== 0) {
        throw new Error(`Benchmark CLI execution failed with exit code ${exitCode}`);
      }
      core.endGroup();
    } else {
      core.info('Skipping aztec-benchmark execution (per only_report input).');
    }

    core.startGroup('Comparing benchmark reports');
    const comparisonInputs = {
      reportsDir,
      baseSuffix,
      prSuffix: currentSuffix,
      threshold,
      circuitDetails
    };
    const markdownResult = runComparison(comparisonInputs);
    core.endGroup();

    const resolvedOutputPath = path.resolve(outputMarkdownPath);
    core.info(`Writing comparison report to: ${resolvedOutputPath}`);
    fs.writeFileSync(resolvedOutputPath, markdownResult);

    core.setOutput('comparison_markdown', markdownResult);
    core.setOutput('markdown_file_path', resolvedOutputPath);

    core.info('Benchmark generation and comparison action completed successfully.');

  } catch (error) {
    core.setFailed(`Action failed: ${error.message}`);
    if (error.stack) {
      core.debug(error.stack);
    }
  }
}

run(); 
