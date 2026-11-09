const { pathToFileURL } = require('node:url');
const { resolve } = require('node:path');

module.exports = class OptimizerReplay {
  id() {
    return 'limitcast-optimizer-replay';
  }
  async callApi(prompt) {
    const { replayOptimization } = await import(pathToFileURL(resolve(__dirname, '../src/optimize-cli.mjs')));
    const events = [{ session_id: 'fixture', hook_event_name: 'UserPromptSubmit' }];
    const add = (name, input, response, id) =>
      events.push({
        session_id: 'fixture',
        hook_event_name: 'PostToolUse',
        tool_name: name,
        tool_input: input,
        tool_response: response,
        tool_use_id: id,
      });
    for (let i = 0; i < 30; i++) {
      if (prompt !== 'exploration') add('Edit', { file_path: 'src/fixture.js' }, {}, `edit-${i}`);
      const code = prompt === 'productive' ? 0 : prompt === 'ambiguous' ? undefined : 1;
      const text = prompt === 'changing' ? `failure-${String.fromCharCode(65 + i)}` : code === 0 ? '1 passed' : 'same assertion failed';
      add('Bash', { command: 'node --test' }, { stdout: text, exit_code: code }, `check-${i}`);
      if (prompt === 'duplicates') events.push(events.at(-1));
    }
    return { output: JSON.stringify(replayOptimization(events, 'codex')) };
  }
};
