//
//  SpeechRecognitionService.swift
//  Vlaude
//
//  Created by Claude on 2025/11/19.
//

import Foundation
import Speech
import AVFoundation
import Combine

class SpeechRecognitionService: ObservableObject {
    @Published var recognizedText = ""
    @Published var isRecording = false
    @Published var isAuthorized = false
    @Published var errorMessage: String?

    private let speechRecognizer: SFSpeechRecognizer?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private let audioEngine = AVAudioEngine()

    // 标记是否是用户主动停止（用于区分主动停止和系统错误）
    private var isManualStop = false

    init() {
        // 默认使用中文识别，可以根据系统语言自动切换
        self.speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: "zh-CN"))

        // 检查是否支持语音识别
        guard speechRecognizer != nil else {
            errorMessage = "当前语言不支持语音识别"
            return
        }
    }

    // 请求授权
    func requestAuthorization() {
        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            DispatchQueue.main.async {
                self?.isAuthorized = (status == .authorized)
                if status != .authorized {
                    self?.errorMessage = "语音识别未授权"
                }
            }
        }
    }

    // 开始录音识别
    func startRecording() {
        // 检查授权
        guard isAuthorized else {
            errorMessage = "需要语音识别权限"
            return
        }

        // 重置手动停止标志
        isManualStop = false

        // 停止之前的任务
        if recognitionTask != nil {
            recognitionTask?.cancel()
            recognitionTask = nil
        }

        // 配置音频会话
        let audioSession = AVAudioSession.sharedInstance()
        do {
            try audioSession.setCategory(.record, mode: .measurement, options: .duckOthers)
            try audioSession.setActive(true, options: .notifyOthersOnDeactivation)
        } catch {
            errorMessage = "音频会话配置失败: \(error.localizedDescription)"
            return
        }

        // 创建识别请求
        recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
        guard let recognitionRequest = recognitionRequest else {
            errorMessage = "无法创建识别请求"
            return
        }

        recognitionRequest.shouldReportPartialResults = true

        // 优先使用设备端识别（更隐私）
        if #available(iOS 13.0, *) {
            recognitionRequest.requiresOnDeviceRecognition = false // 暂时关闭以提高准确度
        }

        // 配置音频输入
        let inputNode = audioEngine.inputNode
        let recordingFormat = inputNode.outputFormat(forBus: 0)
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { [weak self] buffer, _ in
            self?.recognitionRequest?.append(buffer)
        }

        audioEngine.prepare()
        do {
            try audioEngine.start()
        } catch {
            errorMessage = "音频引擎启动失败: \(error.localizedDescription)"
            return
        }

        // 开始识别
        recognitionTask = speechRecognizer?.recognitionTask(with: recognitionRequest) { [weak self] result, error in
            guard let self = self else { return }

            var isFinal = false

            if let result = result {
                // 只在非手动停止时更新识别文本（避免停止后清空已识别的内容）
                if !self.isManualStop {
                    DispatchQueue.main.async {
                        self.recognizedText = result.bestTranscription.formattedString
                    }
                }
                isFinal = result.isFinal
            }

            if error != nil || isFinal {
                DispatchQueue.main.async {
                    // 处理错误情况
                    if let error = error {
                        self.handleRecognitionError(error)
                    }
                    // 只有在非手动停止时才调用 stopRecording
                    // 避免重复调用导致状态混乱
                    if !self.isManualStop {
                        self.stopRecording()
                    }
                }
            }
        }

        isRecording = true
        errorMessage = nil
    }

    // 停止录音
    func stopRecording() {
        // 标记为手动停止（避免误报错误）
        isManualStop = true

        // 安全地停止音频引擎
        if audioEngine.isRunning {
            audioEngine.stop()
            audioEngine.inputNode.removeTap(onBus: 0)
        }

        // 结束识别请求
        recognitionRequest?.endAudio()
        recognitionTask?.cancel()

        recognitionRequest = nil
        recognitionTask = nil
        isRecording = false

        // 清理音频会话
        do {
            try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        } catch {
            print("清理音频会话失败: \(error.localizedDescription)")
        }
    }

    // 处理语音识别错误
    private func handleRecognitionError(_ error: Error) {
        // 如果是用户主动停止，忽略所有错误（包括"无语音检测"等）
        if isManualStop {
            return
        }

        let nsError = error as NSError

        // Speech Framework 错误码定义
        // https://developer.apple.com/documentation/speech/sferror
        switch nsError.code {
        case 216:
            // User cancelled - 用户手动取消，正常行为
            break

        case 201:
            // No speech detected - 未检测到语音，也是正常场景
            // 可以选择性地提示用户，但不应作为错误
            print("未检测到语音输入")

        case 203:
            // Session timeout - 会话超时，正常场景
            print("语音识别会话超时")

        case 1110, 300:
            // Network/Server error - 在线识别时的网络或服务器错误
            self.errorMessage = "网络连接失败，请检查网络设置"

        case 102:
            // Recognition service busy - 识别服务繁忙
            self.errorMessage = "语音识别服务繁忙，请稍后重试"

        case 209:
            // Audio recording error - 音频录制错误
            self.errorMessage = "音频录制失败，请检查麦克风权限"

        default:
            // 其他未知错误
            print("语音识别错误 [\(nsError.code)]: \(error.localizedDescription)")
            self.errorMessage = "识别失败，请重试"
        }
    }
}
