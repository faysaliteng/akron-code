'use strict';
// Tool definitions for the Claude-parity surface implemented in parity.js.
// Split out so `tools.js` stays readable: one array, spread into toolDefinitions.

const S = (properties, required) => ({ type: 'object', properties, required });

module.exports = [
  // ---- discovery ----
  {
    name: 'LS',
    description: 'List the contents of a directory. Cheaper and clearer than a shell `ls` for orienting yourself in a project.',
    parameters: S({
      path: { type: 'string', description: 'Directory to list (default: current working directory)' },
      all: { type: 'boolean', description: 'Include dotfiles' },
      recursive: { type: 'boolean', description: 'Walk the tree (skips node_modules/.git/dist/build)' },
    }),
  },
  {
    name: 'Search',
    description: 'Search file contents across the project with a regex or plain string. Skips binaries and heavy directories. Prefer this over shelling out to grep.',
    parameters: S({
      pattern: { type: 'string', description: 'Regex or plain string to find' },
      path: { type: 'string', description: 'Root directory (default: cwd)' },
      glob: { type: 'string', description: 'Only files matching this glob, e.g. "*.js"' },
      caseSensitive: { type: 'boolean', description: 'Case-sensitive match' },
      maxResults: { type: 'number', description: 'Cap on matches (default 200)' },
    }, ['pattern']),
  },

  // ---- shared task board ----
  {
    name: 'TaskCreate',
    description: 'Create a task on the shared team task board. Tasks are how teammates coordinate: they poll TaskList, claim pending unowned unblocked tasks, and mark them complete.',
    parameters: S({
      subject: { type: 'string', description: 'Short imperative title' },
      description: { type: 'string', description: 'What "done" means for this task' },
      activeForm: { type: 'string', description: 'Present-continuous label shown while in progress' },
      team_name: { type: 'string', description: 'Team whose board this lands on' },
      owner: { type: 'string', description: 'Pre-assign to a teammate name' },
      blockedBy: { type: 'array', items: { type: 'string' }, description: 'Task ids that must finish first' },
      metadata: { type: 'object', description: 'Free-form structured data' },
    }, ['subject']),
  },
  {
    name: 'TaskGet',
    description: 'Read one task from the board, including its description, owner, status and dependency edges.',
    parameters: S({
      taskId: { type: 'string', description: 'Task id (numeric string)' },
      team_name: { type: 'string' },
    }, ['taskId']),
  },
  {
    name: 'TaskUpdate',
    description: 'Update a task: change status (pending|in_progress|completed|deleted), claim it with owner, add dependency edges, or merge metadata (a null value deletes a key).',
    parameters: S({
      taskId: { type: 'string' },
      subject: { type: 'string' },
      description: { type: 'string' },
      activeForm: { type: 'string' },
      status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'deleted'] },
      owner: { type: 'string', description: 'Teammate name claiming the task ("team-lead" is the lead)' },
      addBlocks: { type: 'array', items: { type: 'string' }, description: 'Task ids this task blocks' },
      addBlockedBy: { type: 'array', items: { type: 'string' }, description: 'Task ids that block this task' },
      metadata: { type: 'object', description: 'Merged into existing metadata; null deletes a key' },
      team_name: { type: 'string' },
    }, ['taskId']),
  },
  {
    name: 'TaskList',
    description: 'List the shared task board: statuses, owners and dependency edges. Use it to find claimable work (pending, unowned, unblocked — lowest id first).',
    parameters: S({
      status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
      team_name: { type: 'string' },
    }),
  },

  // ---- teams ----
  {
    name: 'TeamCreate',
    description: 'Create a named team with its own task board and inboxes under ~/.autobot/teams/<name>/. Teammates are addressed by name; the lead is always "team-lead".',
    parameters: S({
      team_name: { type: 'string', description: 'lowercase-hyphen team name' },
      description: { type: 'string' },
      members: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, role: { type: 'string' }, model: { type: 'string' } } }, description: 'Optional roster to add up front' },
    }, ['team_name']),
  },
  {
    name: 'TeamDelete',
    description: 'Archive a team once its work is done. Fails while any teammate is still active.',
    parameters: S({
      team_name: { type: 'string' },
      force: { type: 'boolean', description: 'Archive even with active members' },
    }, ['team_name']),
  },
  {
    name: 'SendMessage',
    description: 'Send a message to a teammate by NAME (or to "team-lead"). Teammates read their inbox; the lead coordinates via these messages.',
    parameters: S({
      to: { type: 'string', description: 'Teammate name, or "team-lead"' },
      message: { type: 'string' },
      summary: { type: 'string', description: 'One-line summary for the recipient' },
      from: { type: 'string' },
      team_name: { type: 'string' },
    }, ['to', 'message']),
  },

  // ---- workflows ----
  {
    name: 'Workflow',
    description: 'Run a deterministic JavaScript workflow script. The script starts with `export const meta = { name, description, phases }` and composes sub-agents with agent(), parallel([() => agent(...)]), pipeline(items, fn, fn) and phase("name"). Deterministic, resumable and cacheable — use it for repeatable multi-agent pipelines.',
    parameters: S({
      script: { type: 'string', description: 'Inline workflow script (ESM export const meta …)' },
      scriptPath: { type: 'string', description: 'Path to a .js workflow script (takes precedence)' },
      name: { type: 'string', description: 'A previously saved named workflow' },
      description: { type: 'string', description: 'Accepted for parity with Claude (ignored by the engine)' },
      title: { type: 'string', description: 'Accepted for parity with Claude (ignored by the engine)' },
      args: { description: 'Value exposed to the script as `args` (string or object)' },
      resumeFromRunId: { type: 'string', description: 'Reuse completed agent() calls from an earlier run' },
    }),
  },
  {
    name: 'TaskOutput',
    description: 'Read the output of a background agent, task, shell or monitor by its id. Set block:true to wait for completion up to `timeout` ms.',
    parameters: S({
      task_id: { type: 'string', description: 'Id of the background task/agent/shell' },
      block: { type: 'boolean', description: 'Wait for completion (default false)' },
      timeout: { type: 'number', description: 'Max wait in ms when block is true (default 30000, max 600000)' },
      taskId: { type: 'string', description: 'Alias for task_id' },
      outputFile: { type: 'string', description: 'Legacy: direct path to an output file' },
      team_name: { type: 'string' },
    }),
  },
  {
    name: 'StructuredOutput',
    description: 'Return your result as structured JSON conforming to the schema your caller gave you. When a sub-agent is asked for structured output, ending with this call is REQUIRED — otherwise the parent cannot use the result.',
    parameters: S({
      data: { type: 'object', description: 'The JSON object matching the requested schema' },
    }, ['data']),
  },

  // ---- plan mode + worktrees ----
  {
    name: 'EnterPlanMode',
    description: 'Switch into plan mode: research and design READ-ONLY, write the plan, then finish with ExitPlanMode. Use it for any non-trivial change so the user approves the approach before you touch source.',
    parameters: S({ reason: { type: 'string', description: 'Why planning is needed' } }),
  },
  {
    name: 'EnterWorktree',
    description: 'Create (or switch into) an isolated git worktree so risky work cannot disturb the main checkout.',
    parameters: S({
      name: { type: 'string', description: 'Worktree name (creates a new worktree)' },
      path: { type: 'string', description: 'Existing worktree path to switch into (mutually exclusive with name)' },
    }),
  },
  {
    name: 'ExitWorktree',
    description: 'Leave the worktree. Choose whether to keep it (merge later) or remove it and discard the changes.',
    parameters: S({
      action: { type: 'string', enum: ['keep', 'remove'] },
      discard_changes: { type: 'boolean', description: 'Required to remove a dirty worktree' },
    }, ['action']),
  },

  // ---- mcp + io ----
  {
    name: 'Mcp',
    description: "Call any connected MCP server's tool by name. Use this when a tool is available through an MCP server but is not exposed as its own tool.",
    parameters: S({
      tool: { type: 'string', description: 'MCP tool name' },
      server: { type: 'string', description: 'MCP server id (optional if the tool name is unique)' },
      arguments: { type: 'object', description: 'Arguments for the MCP tool' },
    }, ['tool']),
  },
  {
    name: 'PowerShell',
    description: 'Run a PowerShell command (Windows). On macOS/Linux it falls back to the login shell.',
    parameters: S({
      command: { type: 'string' },
      timeout: { type: 'number', description: 'Milliseconds, max 600000' },
    }, ['command']),
  },
  {
    name: 'Brief',
    description: 'Send a short status brief to the user mid-run without ending the turn. Use it for long jobs so the user sees progress.',
    parameters: S({ summary: { type: 'string' } }, ['summary']),
  },
  {
    name: 'SendUserFile',
    description: 'Deliver a file from the project folder to the user (attachment card in the transcript).',
    parameters: S({
      path: { type: 'string' },
      name: { type: 'string', description: 'Display name' },
      caption: { type: 'string' },
    }, ['path']),
  },
  {
    name: 'ConnectGitHub',
    description: 'Work with GitHub through the gh CLI: status, list repos, clone, open a PR, open an issue, or run a gh command.',
    parameters: S({
      action: { type: 'string', enum: ['status', 'list', 'clone', 'pr', 'issue', 'run'] },
      repo: { type: 'string' },
      title: { type: 'string' },
      body: { type: 'string' },
      base: { type: 'string' },
      command: { type: 'string', description: 'For action=run: the gh subcommand' },
      limit: { type: 'number' },
      timeout: { type: 'number' },
    }, ['action']),
  },

  // ---- scheduling ----
  {
    name: 'CronCreate',
    description: 'Schedule a recurring prompt with a 5-field cron expression in local time (e.g. "0 9 * * 1-5"). Tasks auto-expire after 7 days unless durable.',
    parameters: S({
      cron: { type: 'string', description: '5-field cron: minute hour day-of-month month day-of-week' },
      prompt: { type: 'string', description: 'What to run at each fire' },
      recurring: { type: 'boolean', description: 'false = fire once then stop' },
      durable: { type: 'boolean', description: 'Survive app restarts (mirrored to .claude/scheduled_tasks.json)' },
      name: { type: 'string' },
    }, ['cron', 'prompt']),
  },
  {
    name: 'CronList',
    description: 'List scheduled cron tasks with their next fire time.',
    parameters: S({}),
  },
  {
    name: 'CronDelete',
    description: 'Delete a scheduled cron task by id.',
    parameters: S({ id: { type: 'string' } }, ['id']),
  },
  {
    name: 'ScheduleWakeup',
    description: 'Schedule a one-off wakeup between 60 and 3600 seconds from now — use it to come back to long-running work or to drive an autonomous loop.',
    parameters: S({
      delaySeconds: { type: 'number', description: '60–3600' },
      prompt: { type: 'string', description: 'What to do when it fires' },
      reason: { type: 'string' },
      sentinel: { type: 'string', description: 'Use "<<autonomous-loop-dynamic>>" to keep an autonomous loop alive' },
    }, ['delaySeconds', 'prompt']),
  },
  {
    name: 'RemoteTrigger',
    description: 'Manage and run remote triggers: action=list|get|create|update|run. Use "run" to fire a saved trigger (webhook, CI, deploy hook); pass an inline {url, method, body, headers} for one-off HTTP calls.',
    parameters: S({
      action: { type: 'string', enum: ['list', 'get', 'create', 'update', 'run'], description: 'Operation (default run)' },
      trigger_id: { type: 'string', description: 'Trigger id for get/update/run' },
      body: { description: 'Request body / trigger definition (object or string)' },
      url: { type: 'string', description: 'Inline one-off URL (implies action=run)' },
      method: { type: 'string', description: 'HTTP method (default POST)' },
      headers: { type: 'object' },
    }),
  },
  {
    name: 'Monitor',
    description: 'Run a long-lived command and surface each stdout line as an event (servers, builds, log tails). Ends on timeout or when the command exits.',
    parameters: S({
      description: { type: 'string', description: 'Human label for the monitor' },
      timeout_ms: { type: 'number', description: 'Default 300000, max 3600000' },
      persistent: { type: 'boolean', description: 'Keep running until stopped (ignore timeout)' },
      command: { type: 'string' },
    }, ['description', 'timeout_ms', 'persistent', 'command']),
  },
  {
    name: 'PushNotification',
    description: 'Push a native desktop notification to the user (finished builds, deploy done, something needs attention).',
    parameters: S({
      message: { type: 'string', description: 'Notification body' },
      status: { type: 'string', enum: ['proactive'], description: 'Always "proactive" — you are notifying without being asked' },
      title: { type: 'string', description: 'Legacy: notification title' },
      body: { type: 'string', description: 'Legacy: alias for message' },
    }, ['message']),
  },
];
