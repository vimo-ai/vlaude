-- AlterTable
ALTER TABLE `vlaude_project` ADD COLUMN `encodedDirName` VARCHAR(500) NULL,
                              ADD COLUMN `projectPath` VARCHAR(500) NULL,
                              ADD INDEX `vlaude_project_encodedDirName_idx`(`encodedDirName`);

-- AlterTable
ALTER TABLE `claude_session` ADD COLUMN `projectPath` VARCHAR(500) NULL,
                              ADD INDEX `claude_session_projectPath_idx`(`projectPath`);
