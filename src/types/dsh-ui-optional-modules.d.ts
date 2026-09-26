/**
 * DSH 0.1.6 的部分 UI 类型扩展包不是每个开发 profile 都会安装。
 * Codingns4DSH 对这些包只做模块扩展导入，不读取运行时导出；缺包时保留
 * 空声明，确保本地类型检查和已安装的 DSH 版本都能继续工作。
 */
declare module '@deepseek-ai/dsh-client-ui-sidebar/client' {}
declare module '@deepseek-ai/dsh-client-ui-workspace/client' {}
