/**
 * 极小的异步顺序队列工具。
 *
 * 设计目标：
 * - 显式保证“后收到的任务必须等前一个任务 settle（成功或失败）后再开始”；
 * - 避免把这种顺序语义散落成手写 `tail = tail.then(...)` 片段；
 * - 保持纯函数风格，方便在宿主页 js_repl、sandbox js_repl 等状态敏感路径复用。
 */

/**
 * 创建单队列顺序执行器。
 *
 * 语义说明：
 * - `enqueue(task)` 会严格按调用顺序执行；
 * - 前一个任务失败不会阻断后续任务；
 * - 返回值保持为“当前任务自己的结果/异常”，不会被队列层吞掉。
 *
 * @returns {{enqueue:(task:()=>Promise<any>|any)=>Promise<any>}}
 */
export function createSequentialAsyncQueue() {
  let tail = Promise.resolve();

  function enqueue(task) {
    const run = tail.catch(() => {}).then(async () => await task());
    tail = run.catch(() => {});
    return run;
  }

  return {
    enqueue
  };
}

/**
 * 创建按 key 分片的顺序队列。
 *
 * 适用场景：
 * - 同一 tab 的 js_repl / js_repl_reset 必须串行；
 * - 不同 tab 之间又不需要彼此阻塞。
 *
 * @returns {{enqueue:(key:string, task:()=>Promise<any>|any)=>Promise<any>}}
 */
export function createKeyedSequentialAsyncQueue() {
  const tails = new Map();

  function enqueue(key, task) {
    const normalizedKey = String(key ?? '');
    const previousTail = tails.get(normalizedKey) || Promise.resolve();
    const run = previousTail.catch(() => {}).then(async () => await task());
    const nextTail = run.catch(() => {});
    tails.set(normalizedKey, nextTail);
    nextTail.finally(() => {
      if (tails.get(normalizedKey) === nextTail) {
        tails.delete(normalizedKey);
      }
    });
    return run;
  }

  return {
    enqueue
  };
}
