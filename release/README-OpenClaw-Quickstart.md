# AgentSleuth GitHub Release Quickstart

## 目标

这份发布包面向 Windows x64。目标是让一台陌生电脑在已经安装 OpenClaw 的前提下，下载本 zip、解压、运行 `AgentSleuth-0.1.0-x64.exe`，完成一次 OpenClaw 接入的检测流程，并生成报告。

## 外部前提

1. Windows x64。
2. OpenClaw 已安装，并满足以下任一条件：
   - 在终端运行 `openclaw --version` 能看到版本号。
   - 或者设置了 `OPENCLAW_CLI` 环境变量，指向 `openclaw-local.cmd` 或 OpenClaw CLI。
   - 或者在 AgentSleuth 的“智能体接入”页面手动填写 OpenClaw CLI 路径。
3. OpenClaw 已完成模型认证；至少能在终端运行一次简单 agent 命令。

## 使用步骤

1. 解压 zip。
2. 双击运行 `AgentSleuth-0.1.0-x64.exe`。
3. 打开“智能体接入”，选择 `OpenClaw Runtime`，点击“检测连接”。
4. 如果连接不可用，在 `OpenClaw CLI 路径` 中填入本机的 OpenClaw CLI 路径并保存。
5. 打开“检测编排”，保持默认 3 个 case，点击运行。
6. 等待流程完成，运行状态应进入 `defense_report_ready`。
7. 打开“防御报告”或“报告工作台”查看生成的报告和证据链。

## 说明

- 默认 3 个 case 是发布版 smoke 流程，用于验证下载包、OpenClaw 接入、Trace 采集、风险识别、策略生成和报告导出的完整闭环。
- 如果要做更大规模测试，可以在“检测编排”页面把 case 数量调高。
- 如果机器没有 OpenClaw 或模型认证失败，内置沙箱和页面仍可打开，但 OpenClaw 真实检测无法完成。
