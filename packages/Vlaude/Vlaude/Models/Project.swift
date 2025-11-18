//
//  Project.swift
//  Vlaude
//
//  Created by Claude on 2025/11/16.
//

import Foundation

struct Project: Identifiable, Codable {
    let id: Int
    let name: String
    let path: String
    let encodedDirName: String?
    let lastAccessed: Date?
    let createdAt: Date
    let updatedAt: Date

    var sessions: [Session]?
}

struct ProjectListResponse: Codable {
    let success: Bool
    let data: [Project]
    let total: Int
    let hasMore: Bool
}
