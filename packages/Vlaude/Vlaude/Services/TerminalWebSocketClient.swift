//
//  TerminalWebSocketClient.swift
//  Vlaude
//
//  WebSocket client for pty-daemon remote terminal access.
//  Connects to ws://<host>:7685 and proxies PTY I/O over WebSocket frames:
//  - Binary frames: PTY output (receive) / keyboard input (send)
//  - Text frames: JSON control messages (List, Attach, Detach, WinsizeUpdate, etc.)
//
//  Uses URLSessionWebSocketTask (built-in, no external deps).
//

import Foundation
import Combine

// MARK: - Connection State

enum TerminalConnectionState: Equatable {
    case disconnected
    case connecting
    case connected
    case attached(sessionId: String)
    case reconnecting(attempt: Int)
}

// MARK: - PTY Session Info (mirrors Rust SessionInfo)

struct PTYSessionInfo: Codable, Identifiable {
    let id: String
    let state: String
    let child_pid: Int32
    let cols: UInt16
    let rows: UInt16
    let ptsname: String
    let child_alive: Bool
    let ring_buffer_bytes: UInt64
    let created_secs_ago: UInt64
    let last_active_secs_ago: UInt64
    let terminal_id: UInt32?

    /// Whether this session is currently attached by a Unix socket client (ETerm).
    /// When true, the WS client won't receive real-time PTY output until detached.
    var isAttachedByETerm: Bool {
        state == "Attached"
    }

    /// Whether this session is daemon-managed (available for WS streaming without takeover)
    var isDaemonManaged: Bool {
        state == "Active" || state == "Idle"
    }
}

// MARK: - Protocol Messages (mirrors Rust protocol.rs)

/// Control request sent as JSON text frame
enum PTYRequest {
    case list
    case create(shell: String?, cols: UInt16, rows: UInt16, workingDir: String?)
    case attach(sessionId: String)
    case detach(sessionId: String, cols: UInt16, rows: UInt16)
    case winsizeUpdate(sessionId: String, cols: UInt16, rows: UInt16)
    case ping
    case kill(sessionId: String)

    func toJSON() -> String {
        var dict: [String: Any] = [:]
        switch self {
        case .list:
            dict["type"] = "List"
        case .create(let shell, let cols, let rows, let workingDir):
            dict["type"] = "Create"
            dict["cols"] = cols
            dict["rows"] = rows
            if let shell = shell { dict["shell"] = shell }
            if let wd = workingDir { dict["working_dir"] = wd }
        case .attach(let sessionId):
            dict["type"] = "Attach"
            dict["session_id"] = sessionId
        case .detach(let sessionId, let cols, let rows):
            dict["type"] = "Detach"
            dict["session_id"] = sessionId
            dict["cols"] = cols
            dict["rows"] = rows
        case .winsizeUpdate(let sessionId, let cols, let rows):
            dict["type"] = "WinsizeUpdate"
            dict["session_id"] = sessionId
            dict["cols"] = cols
            dict["rows"] = rows
        case .ping:
            dict["type"] = "Ping"
        case .kill(let sessionId):
            dict["type"] = "Kill"
            dict["session_id"] = sessionId
        }

        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let json = String(data: data, encoding: .utf8) else {
            return "{}"
        }
        return json
    }
}

// MARK: - Protocol Response

enum PTYResponse {
    case created(sessionId: String)
    case attachReady(sessionId: String, cols: UInt16, rows: UInt16, childPid: Int32, gridSnapshot: String?)
    case attachDeny(sessionId: String, reason: String)
    case detached(sessionId: String)
    case sessionList(sessions: [PTYSessionInfo])
    case killed(sessionId: String)
    case winsizeUpdated(sessionId: String)
    case pong(version: UInt16, sessionCount: Int)
    case shuttingDown
    case sessionEnded(sessionId: String)
    case error(message: String)
    case unknown(raw: String)

    static func parse(json: String) -> PTYResponse {
        guard let data = json.data(using: .utf8),
              let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = dict["type"] as? String else {
            return .unknown(raw: json)
        }

        switch type {
        case "Created":
            let sid = dict["session_id"] as? String ?? ""
            return .created(sessionId: sid)

        case "AttachReady":
            let sid = dict["session_id"] as? String ?? ""
            let cols = (dict["cols"] as? NSNumber)?.uint16Value ?? 80
            let rows = (dict["rows"] as? NSNumber)?.uint16Value ?? 24
            let pid = (dict["child_pid"] as? NSNumber)?.int32Value ?? 0
            let snapshot = dict["grid_snapshot"] as? String
            return .attachReady(sessionId: sid, cols: cols, rows: rows, childPid: pid, gridSnapshot: snapshot)

        case "AttachDeny":
            let sid = dict["session_id"] as? String ?? ""
            let reason = dict["reason"] as? String ?? ""
            return .attachDeny(sessionId: sid, reason: reason)

        case "Detached":
            let sid = dict["session_id"] as? String ?? ""
            return .detached(sessionId: sid)

        case "SessionList":
            if let sessionsArray = dict["sessions"] {
                let sessionsData = try? JSONSerialization.data(withJSONObject: sessionsArray)
                let sessions = sessionsData.flatMap {
                    try? JSONDecoder().decode([PTYSessionInfo].self, from: $0)
                } ?? []
                return .sessionList(sessions: sessions)
            }
            return .sessionList(sessions: [])

        case "Killed":
            let sid = dict["session_id"] as? String ?? ""
            return .killed(sessionId: sid)

        case "WinsizeUpdated":
            let sid = dict["session_id"] as? String ?? ""
            return .winsizeUpdated(sessionId: sid)

        case "Pong":
            let version = (dict["version"] as? NSNumber)?.uint16Value ?? 0
            let count = (dict["session_count"] as? NSNumber)?.intValue ?? 0
            return .pong(version: version, sessionCount: count)

        case "ShuttingDown":
            return .shuttingDown

        case "SessionEnded":
            let sid = dict["session_id"] as? String ?? ""
            return .sessionEnded(sessionId: sid)

        case "Error":
            let msg = dict["message"] as? String ?? "unknown error"
            return .error(message: msg)

        default:
            return .unknown(raw: json)
        }
    }
}

// MARK: - TerminalWebSocketClient

@MainActor
class TerminalWebSocketClient: ObservableObject {

    // MARK: - Published State

    @Published private(set) var connectionState: TerminalConnectionState = .disconnected
    @Published private(set) var availableSessions: [PTYSessionInfo] = []
    @Published private(set) var attachedSessionId: String?
    @Published private(set) var attachedCols: UInt16 = 80
    @Published private(set) var attachedRows: UInt16 = 24
    @Published private(set) var isTakingOver: Bool = false

    // MARK: - Callbacks

    /// Called on main thread when PTY output bytes arrive
    var onPtyOutput: ((Data) -> Void)?

    /// Called on main thread when a control response arrives
    var onControlResponse: ((PTYResponse) -> Void)?

    /// Called on main thread when session ends
    var onSessionEnded: ((String) -> Void)?

    // MARK: - Private

    private var webSocketTask: URLSessionWebSocketTask?
    private var urlSession: URLSession?
    private var host: String = ""
    private var port: UInt16 = 7685
    private var reconnectTimer: Timer?
    private var reconnectAttempt = 0
    private let maxReconnectAttempts = 10
    private let reconnectBaseDelay: TimeInterval = 1.0
    private var pingTimer: Timer?
    private var intentionalDisconnect = false

    /// Pending takeover: after Detach succeeds, auto-send Attach for this session
    private var pendingTakeoverSessionId: String?

    // MARK: - Connection

    /// Connect to the pty-daemon WebSocket server
    /// - Parameters:
    ///   - host: daemon host (e.g., "192.168.1.100" or hostname)
    ///   - port: WebSocket port (default 7685)
    func connect(host: String, port: UInt16 = 7685) {
        self.host = host
        self.port = port
        intentionalDisconnect = false
        reconnectAttempt = 0
        performConnect()
    }

    /// Disconnect and stop reconnecting
    func disconnect() {
        intentionalDisconnect = true
        reconnectTimer?.invalidate()
        reconnectTimer = nil
        pingTimer?.invalidate()
        pingTimer = nil
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        webSocketTask = nil
        connectionState = .disconnected
        attachedSessionId = nil
        isTakingOver = false
        pendingTakeoverSessionId = nil
    }

    // MARK: - Control Commands

    /// List available PTY sessions
    func listSessions() {
        sendControl(.list)
    }

    /// Create a new PTY session
    func createSession(shell: String? = nil, cols: UInt16 = 80, rows: UInt16 = 24, workingDir: String? = nil) {
        sendControl(.create(shell: shell, cols: cols, rows: rows, workingDir: workingDir))
    }

    /// Attach to an existing PTY session (starts binary I/O streaming)
    func attachSession(sessionId: String) {
        sendControl(.attach(sessionId: sessionId))
    }

    /// Detach from the currently attached session
    func detachSession() {
        guard let sid = attachedSessionId else { return }
        sendControl(.detach(sessionId: sid, cols: attachedCols, rows: attachedRows))
    }

    /// Update terminal window size
    func updateWinsize(cols: UInt16, rows: UInt16) {
        guard let sid = attachedSessionId else { return }
        attachedCols = cols
        attachedRows = rows
        sendControl(.winsizeUpdate(sessionId: sid, cols: cols, rows: rows))
    }

    // MARK: - Take Over / Release

    /// Force-detach a session from its current owner (ETerm) then attach from this client.
    ///
    /// The daemon's Detach handler has no ownership check, so any client can detach
    /// any session. Flow: Detach → wait for Detached response → Attach → AttachReady.
    /// During the takeover, `isTakingOver` is true for UI loading indicators.
    func takeOverSession(sessionId: String) {
        guard !isTakingOver else {
            NSLog("[TerminalWS] takeover already in progress")
            return
        }
        guard case .connected = connectionState else {
            NSLog("[TerminalWS] must be connected (not attached) to initiate takeover")
            return
        }

        isTakingOver = true
        pendingTakeoverSessionId = sessionId
        NSLog("[TerminalWS] initiating takeover for session %@", sessionId)

        // Step 1: Force-detach the session.
        // cols/rows = 0 tells daemon to preserve the original PTY dimensions.
        // iPhone renders at the original size and scale-to-fit on screen.
        sendControl(.detach(sessionId: sessionId, cols: 0, rows: 0))
    }

    /// Voluntarily release (detach) the currently attached session so that ETerm
    /// or another client can re-attach.
    func releaseSession(sessionId: String? = nil) {
        let sid = sessionId ?? attachedSessionId
        guard let sid = sid else {
            NSLog("[TerminalWS] no session to release")
            return
        }

        NSLog("[TerminalWS] releasing session %@", sid)
        // cols/rows = 0 tells daemon to preserve the original PTY dimensions
        sendControl(.detach(sessionId: sid, cols: 0, rows: 0))
    }

    /// Send keyboard input bytes to the attached PTY
    func sendInput(_ data: Data) {
        guard attachedSessionId != nil else { return }
        let message = URLSessionWebSocketTask.Message.data(data)
        webSocketTask?.send(message) { error in
            if let error = error {
                NSLog("[TerminalWS] send input error: %@", error.localizedDescription)
            }
        }
    }

    /// Send a single string as keyboard input
    func sendInputString(_ string: String) {
        guard let data = string.data(using: .utf8) else { return }
        sendInput(data)
    }

    /// Send raw bytes as keyboard input
    func sendInputBytes(_ bytes: [UInt8]) {
        sendInput(Data(bytes))
    }

    // MARK: - Private: Connection

    private func performConnect() {
        guard let url = URL(string: "ws://\(host):\(port)") else {
            NSLog("[TerminalWS] invalid URL: ws://%@:%d", host, port)
            connectionState = .disconnected
            return
        }

        connectionState = reconnectAttempt > 0
            ? .reconnecting(attempt: reconnectAttempt)
            : .connecting

        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 10
        config.timeoutIntervalForResource = 300
        urlSession = URLSession(configuration: config)

        let task = urlSession?.webSocketTask(with: url)
        webSocketTask = task
        task?.resume()

        // Start listening for messages
        receiveMessage()

        // Consider connected once the first message exchange succeeds
        // Send a ping to verify connection
        sendControl(.ping)

        NSLog("[TerminalWS] connecting to ws://%@:%d (attempt %d)", host, port, reconnectAttempt)
    }

    private func handleConnectionEstablished() {
        connectionState = .connected
        reconnectAttempt = 0

        // Start periodic pings
        pingTimer?.invalidate()
        pingTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.sendControl(.ping)
            }
        }
    }

    private func handleDisconnection() {
        pingTimer?.invalidate()
        pingTimer = nil
        webSocketTask = nil
        attachedSessionId = nil
        isTakingOver = false
        pendingTakeoverSessionId = nil

        if intentionalDisconnect {
            connectionState = .disconnected
            return
        }

        scheduleReconnect()
    }

    private func scheduleReconnect() {
        guard reconnectAttempt < maxReconnectAttempts else {
            NSLog("[TerminalWS] max reconnect attempts reached")
            connectionState = .disconnected
            return
        }

        reconnectAttempt += 1
        connectionState = .reconnecting(attempt: reconnectAttempt)

        // Exponential backoff: 1s, 2s, 4s, 8s, ... capped at 30s
        let delay = min(reconnectBaseDelay * pow(2.0, Double(reconnectAttempt - 1)), 30.0)
        NSLog("[TerminalWS] reconnecting in %.1f seconds (attempt %d)", delay, reconnectAttempt)

        reconnectTimer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.performConnect()
            }
        }
    }

    // MARK: - Private: Message I/O

    private func sendControl(_ request: PTYRequest) {
        let json = request.toJSON()
        let message = URLSessionWebSocketTask.Message.string(json)
        webSocketTask?.send(message) { error in
            if let error = error {
                NSLog("[TerminalWS] send control error: %@", error.localizedDescription)
            }
        }
    }

    private func receiveMessage() {
        webSocketTask?.receive { [weak self] result in
            Task { @MainActor [weak self] in
                guard let self = self else { return }

                switch result {
                case .success(let message):
                    self.handleMessage(message)
                    // Continue listening
                    self.receiveMessage()

                case .failure(let error):
                    NSLog("[TerminalWS] receive error: %@", error.localizedDescription)
                    self.handleDisconnection()
                }
            }
        }
    }

    private func handleMessage(_ message: URLSessionWebSocketTask.Message) {
        switch message {
        case .string(let text):
            handleTextMessage(text)

        case .data(let data):
            handleBinaryMessage(data)

        @unknown default:
            break
        }
    }

    private func handleTextMessage(_ text: String) {
        let response = PTYResponse.parse(json: text)

        switch response {
        case .pong:
            // Connection confirmed
            if case .connecting = connectionState {
                handleConnectionEstablished()
            } else if case .reconnecting = connectionState {
                handleConnectionEstablished()
            }

        case .attachReady(let sessionId, let cols, let rows, _, _):
            attachedSessionId = sessionId
            attachedCols = cols
            attachedRows = rows
            connectionState = .attached(sessionId: sessionId)

            // Takeover complete — clear loading state
            if isTakingOver && pendingTakeoverSessionId == sessionId {
                isTakingOver = false
                pendingTakeoverSessionId = nil
                NSLog("[TerminalWS] takeover complete for session %@, %dx%d", sessionId, cols, rows)
            } else {
                NSLog("[TerminalWS] attached to session %@, %dx%d", sessionId, cols, rows)
            }

        case .detached(let sessionId):
            // Takeover step 2: Detach succeeded, now send Attach
            if let pending = pendingTakeoverSessionId, pending == sessionId {
                NSLog("[TerminalWS] detach confirmed for takeover, attaching to %@", sessionId)
                sendControl(.attach(sessionId: sessionId))
            } else if attachedSessionId == sessionId {
                // Normal detach (we were the attached client)
                attachedSessionId = nil
                connectionState = .connected
            }

        case .sessionList(let sessions):
            availableSessions = sessions

        case .sessionEnded(let sessionId):
            if attachedSessionId == sessionId {
                attachedSessionId = nil
                connectionState = .connected
            }
            onSessionEnded?(sessionId)

        case .attachDeny(let sessionId, let reason):
            // If takeover attach was denied, abort the takeover
            if isTakingOver && pendingTakeoverSessionId == sessionId {
                NSLog("[TerminalWS] takeover attach denied for %@: %@", sessionId, reason)
                isTakingOver = false
                pendingTakeoverSessionId = nil
            }

        case .error(let msg):
            NSLog("[TerminalWS] server error: %@", msg)
            // If a takeover is in progress, any error aborts it
            if isTakingOver {
                NSLog("[TerminalWS] takeover aborted due to error")
                isTakingOver = false
                pendingTakeoverSessionId = nil
            }

        default:
            break
        }

        onControlResponse?(response)
    }

    private func handleBinaryMessage(_ data: Data) {
        // Binary frames = PTY output when attached
        onPtyOutput?(data)
    }
}
