import fs from "node:fs";
import path from "node:path";

/**
 * @param {Map<string, import("./tasks.js").Task>} tasks
 * @param {string|undefined} sessionId
 * @param {string|undefined} executorName
 * @param {string} directory
 */
export function resolveSessionTasks(tasks, sessionId, executorName, directory) {
  /** @type {import("./tasks.js").Task|null} */
  let priorSessionTask = null;
  const requests = [];
  if (sessionId) {
    for (const task of tasks.values()) {
      if (task.sessionId !== sessionId || (executorName !== undefined && task.executorId !== executorName)) continue;
      if (!priorSessionTask || task.startedAt > priorSessionTask.startedAt) priorSessionTask = task;
      if (task.directory === directory) requests.push(task);
    }
  }
  return { priorSessionTask, requests: requests.filter((task) => !task.internal && !task.summaryOf && task.executorId === priorSessionTask?.executorId) };
}

/**
 * @param {import("./tasks.js").Task[]} recorded
 * @param {string} outputDir
 * @returns {string}
 */
export function writeResumeContext(recorded, outputDir) {
  if (recorded.length === 0) return "";
  recorded.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const priorTask = recorded[recorded.length - 1];
  const contextDir = path.join(outputDir, "resume-context");
  fs.mkdirSync(contextDir, { mode: 0o700 });
  const requests = recorded.slice(0, 1).map((task, index) => {
    const prompt = task.originalPrompt ?? "";
    const file = `request-${index + 1}.txt`;
    const hasFullLength = prompt.length >= (task.promptTotalChars ?? 0);
    const originalRecorded = task.originalPrompt !== undefined;
    const knownComplete = task.originalPromptComplete ?? originalRecorded;
    fs.writeFileSync(path.join(contextDir, file), prompt, { flag: "wx", mode: 0o600 });
    return {
      file,
      taskId: task.id,
      characters: prompt.length,
      complete: originalRecorded && hasFullLength && knownComplete,
      status: task.status,
      incomplete: task.incomplete ?? null,
      failureReason: task.failureReason ?? null,
      finalMarker: task.finalMarker ?? null,
    };
  });
  const manifestPath = path.join(contextDir, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({
    requests,
    directory: priorTask.directory,
    sessionId: priorTask.sessionId,
    previousTaskId: priorTask.id,
  }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return `\n\n## Recorded request context\nThe earliest retained request for this session, executor, and directory is indexed at \`${manifestPath}\`, with its prompt in the file beside it. This restores the original assignment if still retained; it does not replay the conversation or accumulated continuations. Text completeness does not prove this is the original assignment; earlier requests may have been pruned. Use it only if you need the assignment, candidate IDs, constraints, or output contract. Read the prompt in bounded chunks through its end; a truncated tool response is not the complete request. An entry marked complete: false is a partial record, not a recovered assignment. The current continuation takes precedence. Task status is not verified progress; inspect prior deliverables with \`taskferry output <taskId>\` before relying on them. If required context is missing or the original request was pruned, report it instead of inventing candidate IDs or substituting another assignment.`;
}
