# GitAiCommitMessage (GACM)

🤖 **AI 驱动的 Git 提交信息助手** —— 让每一次提交都专业、规范、高效。

基于 Electron + Vue 3 开发的桌面端 Git 助手，深度集成 AI 模型，自动分析代码变更并生成符合 Conventional Commits 规范的提交信息。

## 🌟 核心特性

- **本地优先**：所有 Git 操作均在本地执行，安全可靠。
- **智能分析**：一键分析 Staged 文件的 Diff，自动生成高质量提交说明。
- **流式输出**：AI 生成过程实时预览，所见即所得。
- **多模型支持**：支持 DeepSeek、GLM 等主流大模型。
- **一键提交**：确认信息后可直接完成 Commit 和 Push 操作。

## 🚀 快速开始

### 安装与运行

1. **克隆仓库**
   ```bash
   git clone https://github.com/your-username/git-ai-commit-message.git
   cd git-ai-commit-message
   ```

2. **安装依赖**
   ```bash
   npm install
   ```

3. **启动开发环境**
   ```bash
   npm run dev
   ```

4. **打包应用**
   ```bash
   npm run build:win  # Windows
   npm run build:mac  # macOS
   ```

### 使用流程

1. **添加项目**：点击左侧侧边栏的“添加项目”，选择你的 Git 仓库目录。
2. **暂存文件**：在工作台中查看文件变动，勾选并“暂存”需要提交的文件。
3. **生成信息**：点击右侧 AI 面板的“生成提交信息”按钮。
4. **确认提交**：预览 AI 生成的内容，如有需要可手动微调，最后点击“确认提交”。

## 🤖 模型推荐与对比

本项目支持多种 AI 模型，你可以根据需求在设置中配置：

| 模型 | 速度 | 费用 | 评价 |
| --- | --- | --- | --- |
| **DeepSeek V3/V4** | ⚡ 极快 | 约 0.01 元 / 次 | **推荐**。响应速度极快，逻辑理解能力强。 |
| **GLM 4.7 Flash** | 🐢 较慢 | 🎁 免费 | 适合低频使用或预算有限的用户，但生成等待时间相对较长。 |

> *注：费用估算基于当前 API 价格及平均 Diff 长度。*

## 🛠️ 技术栈

- **运行时**: Electron 30+
- **前端框架**: Vue 3.4+ + TypeScript
- **UI 组件**: Naive UI
- **状态管理**: Pinia
- **Git 操作**: simple-git
- **构建工具**: Vite + electron-vite

## 📄 开源协议

[MIT License](LICENSE)
