//
//  TerminalInputHandler.swift
//  Vlaude
//
//  Converts iOS key presses and UIKeyCommand events into terminal-appropriate
//  byte sequences for transmission over WebSocket to the pty-daemon.
//
//  Covers:
//  - Printable characters (UTF-8)
//  - Enter (\r), Tab (\t), Escape (\x1b), Backspace (\x7f)
//  - Arrow keys, Home, End, Page Up/Down (ANSI escape sequences)
//  - Ctrl+key combos (Ctrl+C = \x03, Ctrl+D = \x04, etc.)
//  - Function keys F1-F12
//

import UIKit

// MARK: - Terminal Input Handler

struct TerminalInputHandler {

    // MARK: - Key Conversion

    /// Convert a text insertion from the software keyboard into terminal bytes
    static func bytesForText(_ text: String) -> Data {
        // The software keyboard sends \n for Return, but terminals expect \r
        let converted = text.replacingOccurrences(of: "\n", with: "\r")
        return Data(converted.utf8)
    }

    /// Convert a UIKeyCommand (hardware keyboard) into terminal bytes
    static func bytesForKeyCommand(_ command: UIKeyCommand) -> Data? {
        let modifiers = command.modifierFlags
        let input = command.input ?? ""

        // Handle special keys first
        if let specialBytes = bytesForSpecialKey(input, modifiers: modifiers) {
            return specialBytes
        }

        // Ctrl+key combos
        if modifiers.contains(.control), input.count == 1 {
            if let bytes = bytesForCtrlKey(input) {
                return bytes
            }
        }

        // Alt/Option+key sends ESC prefix
        if modifiers.contains(.alternate), !input.isEmpty {
            var result = Data([0x1B]) // ESC prefix
            result.append(Data(input.utf8))
            return result
        }

        // Regular printable character (or shifted)
        if !input.isEmpty, modifiers.isEmpty || modifiers == .shift {
            return Data(input.utf8)
        }

        return nil
    }

    // MARK: - Special Keys

    /// Map UIKeyCommand.input special key constants to ANSI sequences
    private static func bytesForSpecialKey(_ input: String, modifiers: UIKeyModifierFlags) -> Data? {
        // Standard keys
        switch input {
        case "\r":
            return Data([0x0D]) // CR

        case "\t":
            if modifiers.contains(.shift) {
                return Data([0x1B, 0x5B, 0x5A]) // ESC[Z (reverse tab)
            }
            return Data([0x09]) // HT

        case UIKeyCommand.inputEscape:
            return Data([0x1B])

        // Arrow keys
        case UIKeyCommand.inputUpArrow:
            return arrowKeyBytes("A", modifiers: modifiers)
        case UIKeyCommand.inputDownArrow:
            return arrowKeyBytes("B", modifiers: modifiers)
        case UIKeyCommand.inputRightArrow:
            return arrowKeyBytes("C", modifiers: modifiers)
        case UIKeyCommand.inputLeftArrow:
            return arrowKeyBytes("D", modifiers: modifiers)

        // Navigation keys
        case UIKeyCommand.inputHome:
            return Data([0x1B, 0x5B, 0x48]) // ESC[H
        case UIKeyCommand.inputEnd:
            return Data([0x1B, 0x5B, 0x46]) // ESC[F
        case UIKeyCommand.inputPageUp:
            return Data([0x1B, 0x5B, 0x35, 0x7E]) // ESC[5~
        case UIKeyCommand.inputPageDown:
            return Data([0x1B, 0x5B, 0x36, 0x7E]) // ESC[6~

        // Delete (forward)
        case UIKeyCommand.inputDelete:
            return Data([0x1B, 0x5B, 0x33, 0x7E]) // ESC[3~

        default:
            break
        }

        // Function keys
        if let fKeyBytes = bytesForFunctionKey(input) {
            return fKeyBytes
        }

        return nil
    }

    /// Generate arrow key sequences with modifier support
    /// Plain: ESC[A  Shift: ESC[1;2A  Alt: ESC[1;3A  Ctrl: ESC[1;5A
    private static func arrowKeyBytes(_ direction: Character, modifiers: UIKeyModifierFlags) -> Data {
        let dirByte = UInt8(direction.asciiValue ?? 0x41)

        if modifiers.isEmpty {
            return Data([0x1B, 0x5B, dirByte]) // ESC[X
        }

        // CSI 1;{modifier}X format
        let mod: UInt8
        if modifiers.contains(.control) && modifiers.contains(.shift) {
            mod = 0x36 // '6'
        } else if modifiers.contains(.control) {
            mod = 0x35 // '5'
        } else if modifiers.contains(.alternate) {
            mod = 0x33 // '3'
        } else if modifiers.contains(.shift) {
            mod = 0x32 // '2'
        } else {
            mod = 0x31 // '1'
        }

        return Data([0x1B, 0x5B, 0x31, 0x3B, mod, dirByte]) // ESC[1;{m}X
    }

    /// Map Ctrl+key to control codes (0x01-0x1A)
    private static func bytesForCtrlKey(_ key: String) -> Data? {
        guard let char = key.uppercased().first,
              let ascii = char.asciiValue else { return nil }

        // Ctrl+A=0x01 ... Ctrl+Z=0x1A
        // Ctrl+[=0x1B (ESC), Ctrl+\=0x1C, Ctrl+]=0x1D, Ctrl+^=0x1E, Ctrl+_=0x1F
        if ascii >= 0x40 && ascii <= 0x5F {
            return Data([ascii - 0x40])
        }
        // Ctrl+Space = NUL
        if key == " " {
            return Data([0x00])
        }
        return nil
    }

    /// Function key escape sequences (F1-F12)
    private static func bytesForFunctionKey(_ input: String) -> Data? {
        // UIKeyCommand uses "UIKeyInputF1" etc. but in practice the input
        // property for function keys varies by iOS version. Handle known patterns.
        let fKeyMap: [String: [UInt8]] = [
            "UIKeyInputF1":  [0x1B, 0x4F, 0x50],       // ESC OP
            "UIKeyInputF2":  [0x1B, 0x4F, 0x51],       // ESC OQ
            "UIKeyInputF3":  [0x1B, 0x4F, 0x52],       // ESC OR
            "UIKeyInputF4":  [0x1B, 0x4F, 0x53],       // ESC OS
            "UIKeyInputF5":  [0x1B, 0x5B, 0x31, 0x35, 0x7E], // ESC[15~
            "UIKeyInputF6":  [0x1B, 0x5B, 0x31, 0x37, 0x7E], // ESC[17~
            "UIKeyInputF7":  [0x1B, 0x5B, 0x31, 0x38, 0x7E], // ESC[18~
            "UIKeyInputF8":  [0x1B, 0x5B, 0x31, 0x39, 0x7E], // ESC[19~
            "UIKeyInputF9":  [0x1B, 0x5B, 0x32, 0x30, 0x7E], // ESC[20~
            "UIKeyInputF10": [0x1B, 0x5B, 0x32, 0x31, 0x7E], // ESC[21~
            "UIKeyInputF11": [0x1B, 0x5B, 0x32, 0x33, 0x7E], // ESC[23~
            "UIKeyInputF12": [0x1B, 0x5B, 0x32, 0x34, 0x7E], // ESC[24~
        ]

        if let bytes = fKeyMap[input] {
            return Data(bytes)
        }
        return nil
    }

    // MARK: - Backspace

    /// The standard terminal backspace byte (DEL = 0x7F)
    static let backspace = Data([0x7F])

    // MARK: - Key Commands for UIResponder

    /// Generate the full set of UIKeyCommands for terminal input capture.
    /// Call from overriding `keyCommands` in a UIView/UIViewController.
    static func terminalKeyCommands() -> [UIKeyCommand] {
        var commands: [UIKeyCommand] = []

        // Arrow keys (plain, shift, ctrl, alt)
        let arrows = [
            UIKeyCommand.inputUpArrow,
            UIKeyCommand.inputDownArrow,
            UIKeyCommand.inputLeftArrow,
            UIKeyCommand.inputRightArrow,
        ]
        let arrowModifiers: [UIKeyModifierFlags] = [[], .shift, .control, .alternate]
        for arrow in arrows {
            for mod in arrowModifiers {
                let cmd = UIKeyCommand(input: arrow, modifierFlags: mod, action: #selector(TerminalKeyResponder.handleTerminalKeyCommand(_:)))
                cmd.wantsPriorityOverSystemBehavior = true
                commands.append(cmd)
            }
        }

        // Escape
        let escCmd = UIKeyCommand(input: UIKeyCommand.inputEscape, modifierFlags: [], action: #selector(TerminalKeyResponder.handleTerminalKeyCommand(_:)))
        escCmd.wantsPriorityOverSystemBehavior = true
        commands.append(escCmd)

        // Tab (plain and shift)
        for mod: UIKeyModifierFlags in [[], .shift] {
            let tabCmd = UIKeyCommand(input: "\t", modifierFlags: mod, action: #selector(TerminalKeyResponder.handleTerminalKeyCommand(_:)))
            tabCmd.wantsPriorityOverSystemBehavior = true
            commands.append(tabCmd)
        }

        // Ctrl+A through Ctrl+Z
        for code in UInt8(ascii: "a")...UInt8(ascii: "z") {
            let char = String(UnicodeScalar(code))
            let cmd = UIKeyCommand(input: char, modifierFlags: .control, action: #selector(TerminalKeyResponder.handleTerminalKeyCommand(_:)))
            cmd.wantsPriorityOverSystemBehavior = true
            commands.append(cmd)
        }

        // Ctrl+special: [, \, ], ^, _
        for char in ["[", "\\", "]", "^", "_"] {
            let cmd = UIKeyCommand(input: char, modifierFlags: .control, action: #selector(TerminalKeyResponder.handleTerminalKeyCommand(_:)))
            cmd.wantsPriorityOverSystemBehavior = true
            commands.append(cmd)
        }

        // Navigation keys
        for key in [UIKeyCommand.inputHome, UIKeyCommand.inputEnd,
                    UIKeyCommand.inputPageUp, UIKeyCommand.inputPageDown,
                    UIKeyCommand.inputDelete] {
            let cmd = UIKeyCommand(input: key, modifierFlags: [], action: #selector(TerminalKeyResponder.handleTerminalKeyCommand(_:)))
            cmd.wantsPriorityOverSystemBehavior = true
            commands.append(cmd)
        }

        return commands
    }
}

// MARK: - Terminal Key Responder Protocol

/// Protocol for views that handle terminal key commands.
/// Conforming UIView must implement handleTerminalKeyCommand(_:)
@objc protocol TerminalKeyResponder {
    @objc func handleTerminalKeyCommand(_ sender: UIKeyCommand)
}
