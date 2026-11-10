# I7：状态交接显式化

- `MemoryStore.append` / `JsonlStore.append` 现在返回应用事件后的 `state`。
- `ProjectHandle._appendEvents` 显式 `this.state = this.store.append(commit)`，随后
  `assertStateAttached(this)`；`handle.state !== store.state` 时抛 `state-desync`（500）。
- `test/alias-guard.test.mjs` 覆盖：跨 commit 同一对象、失败命令不移动 rev、以及
  人为把 `handle.state` 换成 clone 时 `assertStateAttached` 必须失败。
- 历史风险：旧实现依赖「handle.state 与 store.state 恰好同一对象」但没有断言；
  任何把 state 换成深拷贝的重构都会静默丢写。现在这个假设变成显式交接 + 守卫。
- 对照：`npm test` 全绿、`replay-snapshot` 深相等、`mutation-check` 7/7。
