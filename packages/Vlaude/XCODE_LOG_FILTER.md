# Xcode 日志过滤配置

## 问题描述

运行应用时会出现大量系统级别的日志噪音：
- 输入法候选词系统日志 (`containerToPush is nil`)
- AutoLayout 约束冲突警告
- RunningBoard 权限警告
- LaunchServices 数据库访问错误

这些日志不影响应用功能，但会干扰调试。

---

## 解决方案：配置 Xcode 环境变量

### 步骤 1：打开 Scheme 编辑器

1. 在 Xcode 中，点击顶部工具栏的 **Scheme 下拉菜单**
2. 选择 **Edit Scheme...**（或按 `⌘ + <`）

### 步骤 2：添加环境变量

在左侧选择 **Run** → **Arguments** 标签页，在 **Environment Variables** 部分添加以下变量：

| Name | Value | 说明 |
|------|-------|------|
| `OS_ACTIVITY_MODE` | `disable` | 禁用系统活动日志 |
| `OS_ACTIVITY_DT_MODE` | `NO` | 禁用开发工具模式的活动日志 |
| `IDEPreferLogStreaming` | `YES` | 使用日志流式传输（更干净） |

### 步骤 3：添加启动参数（可选）

在 **Arguments Passed On Launch** 部分添加：

```
-com.apple.CoreData.ConcurrencyDebug 0
-com.apple.CoreData.SQLDebug 0
```

---

## 进阶：使用控制台过滤器

如果仍有噪音日志，可以在 Xcode 控制台底部的**过滤框**中添加以下正则表达式：

```
^(?!.*(containerToPush|RTIInputSystemClient|LaunchServices|UIConstraint)).*$
```

这会**只显示**不包含以下关键词的日志：
- `containerToPush`
- `RTIInputSystemClient`
- `LaunchServices`
- `UIConstraint`

---

## 效果对比

### 配置前：
```
Received external candidate resultset. Total number of candidates: 16
containerToPush is nil, will not push anything to candidate receiver
Unable to simultaneously satisfy constraints...
LaunchServices: store (null) or url (null) was nil
[你的应用日志]
RTIInputSystemClient remoteTextInputSessionWithID...
```

### 配置后：
```
[你的应用日志]
```

---

## 注意事项

1. **环境变量配置仅影响当前 Scheme**
   - 如果有多个 Scheme（Debug/Release），需要分别配置

2. **不影响真实错误**
   - 你的应用代码中的 `print()` 和 `NSLog()` 仍会正常显示
   - 只是过滤了系统框架的调试日志

3. **发布版本不受影响**
   - 这些配置只在开发阶段生效
   - Release 构建不会包含这些调试日志

---

## 针对特定问题的额外配置

### 如果仍看到 AutoLayout 警告

在代码中添加（仅用于调试）：

```swift
#if DEBUG
UserDefaults.standard.set(false, forKey: "_UIConstraintBasedLayoutLogUnsatisfiable")
#endif
```

放在 `AppDelegate` 或 `@main` 入口的 `init()` 方法中。

---

## 总结

- ✅ 推荐使用环境变量 `OS_ACTIVITY_MODE=disable`
- ✅ 使用控制台过滤器进一步减少噪音
- ⚠️ 这些配置不会影响你应用的日志输出
- ⚠️ 真实的崩溃和错误仍会显示

配置后，你将看到一个干净的调试环境，专注于你自己的应用日志。
