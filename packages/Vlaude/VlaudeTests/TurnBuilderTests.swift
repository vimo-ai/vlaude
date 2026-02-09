//
//  TurnBuilderTests.swift
//  VlaudeTests
//
//  TurnBuilder 单元测试
//  覆盖实时推送和历史批量处理场景
//

import Testing
@testable import Vlaude

struct TurnBuilderTests {

    // MARK: - Helper: Message 构造器

    /// 创建测试用 Message（简化版，大部分字段为 nil）
    private func makeMessage(
        uuid: String? = nil,
        type: String,
        timestamp: String? = nil,
        sessionId: String? = nil,
        parentUuid: String? = nil,
        message: MessageInner? = nil,
        contentBlocks: [ContentBlock]? = nil,
        eventType: String? = nil,
        stopReason: String? = nil,
        agentId: String? = nil,
        toolUseResult: JSONValue? = nil
    ) -> Message {
        return Message(
            uuid: uuid,
            type: type,
            timestamp: timestamp,
            sessionId: sessionId,
            parentUuid: parentUuid,
            message: message,
            contentBlocks: contentBlocks,
            isSidechain: nil,
            userType: nil,
            cwd: nil,
            version: nil,
            gitBranch: nil,
            requestId: nil,
            agentId: agentId,
            isApiErrorMessage: nil,
            eventType: eventType,
            toolUseResult: toolUseResult,
            thinkingMetadata: nil,
            isVisibleInTranscriptOnly: nil,
            isCompactSummary: nil,
            isMeta: nil,
            subtype: nil,
            level: nil,
            systemContent: nil,
            toolUseID: nil,
            hookCount: nil,
            hookInfos: nil,
            hookErrors: nil,
            preventedContinuation: nil,
            stopReason: stopReason,
            hasOutput: nil,
            error: nil,
            retryInMs: nil,
            retryAttempt: nil,
            maxRetries: nil,
            cause: nil,
            logicalParentUuid: nil,
            compactMetadata: nil,
            summary: nil,
            leafUuid: nil,
            operation: nil,
            messageId: nil,
            snapshot: nil,
            isSnapshotUpdate: nil,
            clientMessageId: nil,
            toolCallId: nil,
            approvalStatus: nil,
            approvalResolvedAt: nil,
            mergedToolExecutions: []
        )
    }

    /// 创建带有文本内容的 MessageInner
    private func makeTextMessageInner(text: String) -> MessageInner {
        return MessageInner(role: "user", content: .string(text))
    }

    /// 创建带有 thinking + text 的 assistant MessageInner
    private func makeAssistantMessageInner(thinking: String? = nil, text: String? = nil, toolUseName: String? = nil, toolUseId: String? = nil, toolUseInput: [String: JSONValue]? = nil) -> MessageInner {
        var items: [JSONValue] = []

        if let thinking = thinking {
            items.append(.object([
                "type": .string("thinking"),
                "thinking": .string(thinking)
            ]))
        }

        if let text = text {
            items.append(.object([
                "type": .string("text"),
                "text": .string(text)
            ]))
        }

        if let name = toolUseName, let id = toolUseId {
            var tool: [String: JSONValue] = [
                "type": .string("tool_use"),
                "id": .string(id),
                "name": .string(name)
            ]
            if let input = toolUseInput {
                tool["input"] = .object(input)
            }
            items.append(.object(tool))
        }

        return MessageInner(role: "assistant", content: .array(items))
    }

    /// 创建 tool_result MessageInner
    private func makeToolResultMessageInner(toolUseId: String, content: String, isError: Bool = false) -> MessageInner {
        return MessageInner(role: "user", content: .array([
            .object([
                "type": .string("tool_result"),
                "tool_use_id": .string(toolUseId),
                "content": .string(content),
                "is_error": .bool(isError)
            ])
        ]))
    }

    // MARK: - 测试用例

    @Test("空消息列表 → 0 个 Turn")
    func testEmptyMessages() {
        let builder = TurnBuilder()
        builder.processHistoryMessages([])
        #expect(builder.turns.isEmpty)
    }

    @Test("单个完整 Turn（user_text + assistant text + end_turn）")
    func testSingleCompleteTurn() {
        let builder = TurnBuilder()

        let messages: [Message] = [
            makeMessage(
                uuid: "user-1",
                type: "user",
                timestamp: "2025-01-01T00:00:00.000Z",
                message: makeTextMessageInner(text: "Hello"),
                eventType: "user_text"
            ),
            makeMessage(
                uuid: "asst-1",
                type: "assistant",
                timestamp: "2025-01-01T00:00:01.000Z",
                message: makeAssistantMessageInner(text: "Hi there!"),
                eventType: "text",
                stopReason: "end_turn"
            )
        ]

        builder.processHistoryMessages(messages)

        #expect(builder.turns.count == 1)

        let turn = builder.turns[0]
        #expect(turn.id == "user-1")
        #expect(turn.userMessage.textContent == "Hello")
        #expect(turn.status == .completed)
        #expect(turn.events.count == 1)
        #expect(turn.events[0].eventType == .text)
    }

    @Test("多个完整 Turn（3 轮对话）")
    func testMultipleCompleteTurns() {
        let builder = TurnBuilder()

        let messages: [Message] = [
            // Turn 1
            makeMessage(uuid: "user-1", type: "user", message: makeTextMessageInner(text: "Q1"), eventType: "user_text"),
            makeMessage(uuid: "asst-1", type: "assistant", message: makeAssistantMessageInner(text: "A1"), stopReason: "end_turn"),

            // Turn 2
            makeMessage(uuid: "user-2", type: "user", message: makeTextMessageInner(text: "Q2"), eventType: "user_text"),
            makeMessage(uuid: "asst-2", type: "assistant", message: makeAssistantMessageInner(text: "A2"), stopReason: "end_turn"),

            // Turn 3
            makeMessage(uuid: "user-3", type: "user", message: makeTextMessageInner(text: "Q3"), eventType: "user_text"),
            makeMessage(uuid: "asst-3", type: "assistant", message: makeAssistantMessageInner(text: "A3"), stopReason: "end_turn")
        ]

        builder.processHistoryMessages(messages)

        #expect(builder.turns.count == 3)
        #expect(builder.turns[0].userMessage.textContent == "Q1")
        #expect(builder.turns[1].userMessage.textContent == "Q2")
        #expect(builder.turns[2].userMessage.textContent == "Q3")
        #expect(builder.turns[2].status == .completed)
    }

    @Test("无 user_text 的不完整数据 → 0 个 Turn（修复的 bug）")
    func testPartialDataNoUserText() {
        let builder = TurnBuilder()

        // 只有 assistant/tool 消息，没有 user_text
        let messages: [Message] = [
            makeMessage(uuid: "asst-1", type: "assistant", message: makeAssistantMessageInner(text: "Response"), stopReason: "end_turn")
        ]

        builder.processHistoryMessages(messages)

        // 没有 user_text 无法创建 Turn，所以应该是 0
        #expect(builder.turns.isEmpty)
    }

    @Test("Tool 循环：user_text → thinking → tool_use → tool_result → text → end_turn")
    func testTurnWithToolCycle() {
        let builder = TurnBuilder()

        let messages: [Message] = [
            // User 提问
            makeMessage(uuid: "user-1", type: "user", message: makeTextMessageInner(text: "Read file.txt"), eventType: "user_text"),

            // Assistant 思考
            makeMessage(uuid: "asst-1", type: "assistant", message: makeAssistantMessageInner(thinking: "I need to read the file"), eventType: "thinking"),

            // Tool use
            makeMessage(
                uuid: "asst-2",
                type: "assistant",
                message: makeAssistantMessageInner(toolUseName: "Read", toolUseId: "tool-1", toolUseInput: ["file_path": .string("file.txt")]),
                eventType: "tool_use",
                stopReason: "tool_use"
            ),

            // Tool result
            makeMessage(uuid: "user-2", type: "user", message: makeToolResultMessageInner(toolUseId: "tool-1", content: "File content here"), eventType: "tool_result"),

            // Final response
            makeMessage(uuid: "asst-3", type: "assistant", message: makeAssistantMessageInner(text: "Here is the content"), eventType: "text", stopReason: "end_turn")
        ]

        builder.processHistoryMessages(messages)

        #expect(builder.turns.count == 1)

        let turn = builder.turns[0]
        #expect(turn.id == "user-1")
        #expect(turn.status == .completed)

        // 验证事件顺序：thinking → tool_use → text
        #expect(turn.events.count == 3)
        #expect(turn.events[0].eventType == .thinking)
        #expect(turn.events[1].eventType == .toolUse)
        #expect(turn.events[2].eventType == .text)

        // 验证 tool_result 被合并进 tool_use
        if case .toolUse(let execution) = turn.events[1].content {
            #expect(execution.result != nil)
            #expect(execution.result?.content == "File content here")
        } else {
            #expect(Bool(false), "Expected toolUse event")
        }
    }

    @Test("未完成的 Turn（无 end_turn）→ processHistoryMessages 标记为 completed")
    func testOpenTurnNoEndTurn() {
        let builder = TurnBuilder()

        let messages: [Message] = [
            makeMessage(uuid: "user-1", type: "user", message: makeTextMessageInner(text: "Question"), eventType: "user_text"),
            makeMessage(uuid: "asst-1", type: "assistant", message: makeAssistantMessageInner(thinking: "Thinking..."), eventType: "thinking")
            // 没有 end_turn
        ]

        builder.processHistoryMessages(messages)

        #expect(builder.turns.count == 1)

        let turn = builder.turns[0]
        // 历史数据最后一个 Turn 没有 end_turn，processHistoryMessages 应标记为 completed
        #expect(turn.status == .completed)
    }

    @Test("实时逐条推送（processMessage）")
    func testRealtimeAppend() {
        let builder = TurnBuilder()

        // 逐条推送
        builder.processMessage(makeMessage(uuid: "user-1", type: "user", message: makeTextMessageInner(text: "Hi"), eventType: "user_text"))
        #expect(builder.turns.count == 1)
        #expect(builder.turns[0].status == .active)

        builder.processMessage(makeMessage(uuid: "asst-1", type: "assistant", message: makeAssistantMessageInner(thinking: "Processing"), eventType: "thinking"))
        #expect(builder.turns[0].events.count == 1)

        builder.processMessage(makeMessage(uuid: "asst-2", type: "assistant", message: makeAssistantMessageInner(text: "Hello"), eventType: "text", stopReason: "end_turn"))
        #expect(builder.turns[0].events.count == 2)
        #expect(builder.turns[0].status == .completed)
    }

    @Test("历史加载后实时追加新消息")
    func testRealtimeAfterHistory() {
        let builder = TurnBuilder()

        // 历史消息
        let history: [Message] = [
            makeMessage(uuid: "user-1", type: "user", message: makeTextMessageInner(text: "Old question"), eventType: "user_text"),
            makeMessage(uuid: "asst-1", type: "assistant", message: makeAssistantMessageInner(text: "Old answer"), stopReason: "end_turn")
        ]
        builder.processHistoryMessages(history)
        #expect(builder.turns.count == 1)

        // 新消息实时追加
        builder.processMessage(makeMessage(uuid: "user-2", type: "user", message: makeTextMessageInner(text: "New question"), eventType: "user_text"))
        #expect(builder.turns.count == 2)
        #expect(builder.turns[1].userMessage.textContent == "New question")
    }

    @Test("Tool result 匹配到对应的 tool_use")
    func testToolResultMatching() {
        let builder = TurnBuilder()

        let messages: [Message] = [
            makeMessage(uuid: "user-1", type: "user", message: makeTextMessageInner(text: "Execute"), eventType: "user_text"),
            makeMessage(
                uuid: "asst-1",
                type: "assistant",
                message: makeAssistantMessageInner(toolUseName: "Bash", toolUseId: "bash-123", toolUseInput: ["command": .string("ls")]),
                eventType: "tool_use"
            ),
            makeMessage(uuid: "user-2", type: "user", message: makeToolResultMessageInner(toolUseId: "bash-123", content: "file1.txt\nfile2.txt"), eventType: "tool_result")
        ]

        builder.processHistoryMessages(messages)

        #expect(builder.turns.count == 1)
        let turn = builder.turns[0]
        #expect(turn.events.count == 1)

        if case .toolUse(let execution) = turn.events[0].content {
            #expect(execution.id == "bash-123")
            #expect(execution.name == "Bash")
            #expect(execution.result != nil)
            #expect(execution.result?.content.contains("file1.txt") == true)
        } else {
            #expect(Bool(false), "Expected toolUse with result")
        }
    }

    @Test("Subagent 消息归入 subagentTurns")
    func testSubagentMessages() {
        let builder = TurnBuilder()

        let messages: [Message] = [
            makeMessage(uuid: "user-1", type: "user", message: makeTextMessageInner(text: "Question"), eventType: "user_text"),
            makeMessage(uuid: "asst-1", type: "assistant", message: makeAssistantMessageInner(thinking: "Main thinking"), eventType: "thinking"),
            makeMessage(uuid: "sub-1", type: "assistant", message: makeAssistantMessageInner(text: "Subagent response"), eventType: "text", agentId: "agent-alpha")
        ]

        builder.processHistoryMessages(messages)

        #expect(builder.turns.count == 1)
        let turn = builder.turns[0]

        // 主 Turn 只有 1 个事件（main thinking）
        #expect(turn.events.count == 1)

        // Subagent 消息在 subagentTurns 中
        #expect(turn.subagentTurns.count == 1)
        #expect(turn.subagentTurns[0].id == "agent-alpha")
        #expect(turn.subagentTurns[0].events.count == 1)
    }

    @Test("System 类型消息被跳过")
    func testSystemMessagesSkipped() {
        let builder = TurnBuilder()

        let messages: [Message] = [
            makeMessage(uuid: "sys-1", type: "system"),
            makeMessage(uuid: "user-1", type: "user", message: makeTextMessageInner(text: "Hi"), eventType: "user_text"),
            makeMessage(uuid: "sys-2", type: "system"),
            makeMessage(uuid: "asst-1", type: "assistant", message: makeAssistantMessageInner(text: "Hello"), stopReason: "end_turn")
        ]

        builder.processHistoryMessages(messages)

        #expect(builder.turns.count == 1)
        #expect(builder.turns[0].userMessage.textContent == "Hi")
    }

    @Test("连续两个 user_text → 创建两个独立 Turn")
    func testConsecutiveUserTexts() {
        let builder = TurnBuilder()

        let messages: [Message] = [
            makeMessage(uuid: "user-1", type: "user", message: makeTextMessageInner(text: "First"), eventType: "user_text"),
            makeMessage(uuid: "user-2", type: "user", message: makeTextMessageInner(text: "Second"), eventType: "user_text")
        ]

        builder.processHistoryMessages(messages)

        #expect(builder.turns.count == 2)
        #expect(builder.turns[0].userMessage.textContent == "First")
        #expect(builder.turns[1].userMessage.textContent == "Second")

        // 第一个 Turn 自动关闭（用户发送第二条消息 = 第一轮结束）
        #expect(builder.turns[0].status == .completed)
    }

    @Test("大量 Tool 循环（20 轮 tool_use + tool_result）")
    func testLargeToolCycle() {
        let builder = TurnBuilder()

        var messages: [Message] = [
            makeMessage(uuid: "user-1", type: "user", message: makeTextMessageInner(text: "Complex task"), eventType: "user_text")
        ]

        // 添加 20 轮 tool_use + tool_result
        for i in 1...20 {
            messages.append(makeMessage(
                uuid: "tool-use-\(i)",
                type: "assistant",
                message: makeAssistantMessageInner(toolUseName: "Read", toolUseId: "tool-\(i)", toolUseInput: ["file_path": .string("file\(i).txt")]),
                eventType: "tool_use",
                stopReason: "tool_use"
            ))
            messages.append(makeMessage(
                uuid: "tool-result-\(i)",
                type: "user",
                message: makeToolResultMessageInner(toolUseId: "tool-\(i)", content: "Content \(i)"),
                eventType: "tool_result"
            ))
        }

        messages.append(makeMessage(uuid: "asst-final", type: "assistant", message: makeAssistantMessageInner(text: "Done"), stopReason: "end_turn"))

        builder.processHistoryMessages(messages)

        #expect(builder.turns.count == 1)
        let turn = builder.turns[0]

        // 20 个 tool_use + 1 个 text = 21 个事件
        #expect(turn.events.count == 21)

        // 验证所有 tool_use 都有 result
        let toolEvents = turn.events.filter { $0.eventType == .toolUse }
        #expect(toolEvents.count == 20)

        for event in toolEvents {
            if case .toolUse(let execution) = event.content {
                #expect(execution.result != nil, "Tool \(execution.id) should have result")
            }
        }
    }

    @Test("空白 text 内容被过滤")
    func testEmptyTextFiltered() {
        let builder = TurnBuilder()

        let messages: [Message] = [
            makeMessage(uuid: "user-1", type: "user", message: makeTextMessageInner(text: "Question"), eventType: "user_text"),
            makeMessage(uuid: "asst-1", type: "assistant", message: makeAssistantMessageInner(text: "   \n  "), eventType: "text"), // 空白文本
            makeMessage(uuid: "asst-2", type: "assistant", message: makeAssistantMessageInner(text: "Real response"), stopReason: "end_turn")
        ]

        builder.processHistoryMessages(messages)

        #expect(builder.turns.count == 1)
        let turn = builder.turns[0]

        // 空白文本应该被过滤掉，只有 1 个有效 text 事件
        #expect(turn.events.count == 1)
        if case .text(let text, _) = turn.events[0].content {
            #expect(text == "Real response")
        } else {
            #expect(Bool(false), "Expected text event")
        }
    }

    @Test("stopReason=tool_use 改变 Turn 状态为 waitingTool")
    func testToolUseChangesStatus() {
        let builder = TurnBuilder()

        builder.processMessage(makeMessage(uuid: "user-1", type: "user", message: makeTextMessageInner(text: "Run tool"), eventType: "user_text"))
        #expect(builder.turns[0].status == .active)

        builder.processMessage(makeMessage(
            uuid: "asst-1",
            type: "assistant",
            message: makeAssistantMessageInner(toolUseName: "Bash", toolUseId: "bash-1"),
            eventType: "tool_use",
            stopReason: "tool_use"
        ))

        // 状态应变为 waitingTool
        #expect(builder.turns[0].status == .waitingTool)

        // tool_result 到来后恢复 active
        builder.processMessage(makeMessage(uuid: "user-2", type: "user", message: makeToolResultMessageInner(toolUseId: "bash-1", content: "Done"), eventType: "tool_result"))
        #expect(builder.turns[0].status == .active)

        // end_turn 后变为 completed
        builder.processMessage(makeMessage(uuid: "asst-2", type: "assistant", message: makeAssistantMessageInner(text: "Finished"), stopReason: "end_turn"))
        #expect(builder.turns[0].status == .completed)
    }

    @Test("Clear 方法清空所有状态")
    func testClearResetsState() {
        let builder = TurnBuilder()

        let messages: [Message] = [
            makeMessage(uuid: "user-1", type: "user", message: makeTextMessageInner(text: "Test"), eventType: "user_text"),
            makeMessage(uuid: "asst-1", type: "assistant", message: makeAssistantMessageInner(text: "Response"), stopReason: "end_turn")
        ]
        builder.processHistoryMessages(messages)
        #expect(builder.turns.count == 1)

        builder.clear()
        #expect(builder.turns.isEmpty)

        // 清空后可以重新开始
        builder.processMessage(makeMessage(uuid: "user-2", type: "user", message: makeTextMessageInner(text: "New"), eventType: "user_text"))
        #expect(builder.turns.count == 1)
        #expect(builder.turns[0].id == "user-2")
    }
}
