import { codebaseTasks } from './codebase.js';
import { securityTasks } from './security.js';
import type { EvalTask, TaskGroup } from '../lib/types.js';

export const ALL_TASKS: EvalTask[] = [...codebaseTasks, ...securityTasks];

export function selectTasks(opts: { group?: TaskGroup; filter?: string }): EvalTask[] {
  let tasks = ALL_TASKS;
  if (opts.group) tasks = tasks.filter((t) => t.group === opts.group);
  if (opts.filter) {
    const needle = opts.filter.toLowerCase();
    tasks = tasks.filter(
      (t) => t.id.toLowerCase().includes(needle) || t.intent.toLowerCase().includes(needle),
    );
  }
  return tasks;
}

export { codebaseTasks, securityTasks };
