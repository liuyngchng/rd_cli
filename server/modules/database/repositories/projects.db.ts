import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { getConnection } from '@/modules/database/connection.js';
import type { CreateProjectPathResult, ProjectRepositoryRow } from '@/shared/types.js';
import { normalizeProjectPath } from '@/shared/utils.js';

function normalizeProjectDisplayName(projectPath: string, customProjectName: string | null): string {
    const trimmedCustomName = typeof customProjectName === 'string' ? customProjectName.trim() : '';
    if (trimmedCustomName.length > 0) {
        return trimmedCustomName;
    }

    const directoryName = path.basename(projectPath);
    return directoryName || projectPath;
}

export const projectsDb = {
    createProjectPath(projectPath: string, customProjectName: string | null = null, userId?: number): CreateProjectPathResult {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        const normalizedProjectName = normalizeProjectDisplayName(normalizedProjectPath, customProjectName);
        const attemptedId = randomUUID();
        const row = db.prepare(`
        INSERT INTO projects (project_id, project_path, custom_project_name, isArchived, user_id)
            VALUES (?, ?, ?, 0, ?)
            ON CONFLICT(project_path) DO UPDATE SET
            isArchived = 0,
            user_id = COALESCE(excluded.user_id, projects.user_id)
            WHERE projects.isArchived = 1
            RETURNING project_id, project_path, custom_project_name, isStarred, isArchived, user_id
        `).get(attemptedId, normalizedProjectPath, normalizedProjectName, userId ?? null) as ProjectRepositoryRow | undefined;

        if (row) {
            return {
                outcome: row.project_id === attemptedId ? 'created' : 'reactivated_archived',
                project: row,
            };
        }

        const existingProject = projectsDb.getProjectPath(normalizedProjectPath, userId);
        return {
            outcome: 'active_conflict',
            project: existingProject,
        };
    },

    getProjectPath(projectPath: string, userId?: number): ProjectRepositoryRow | null {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        const row = userId != null
            ? db.prepare(`
                SELECT project_id, project_path, custom_project_name, isStarred, isArchived, user_id
                FROM projects
                WHERE project_path = ? AND (user_id = ? OR user_id IS NULL)
            `).get(normalizedProjectPath, userId) as ProjectRepositoryRow | undefined
            : db.prepare(`
                SELECT project_id, project_path, custom_project_name, isStarred, isArchived, user_id
                FROM projects
                WHERE project_path = ?
            `).get(normalizedProjectPath) as ProjectRepositoryRow | undefined;

        return row ?? null;
    },

    getProjectById(projectId: string, userId?: number): ProjectRepositoryRow | null {
        const db = getConnection();
        const row = userId != null
            ? db.prepare(`
                SELECT project_id, project_path, custom_project_name, isStarred, isArchived, user_id
                FROM projects
                WHERE project_id = ? AND (user_id = ? OR user_id IS NULL)
            `).get(projectId, userId) as ProjectRepositoryRow | undefined
            : db.prepare(`
                SELECT project_id, project_path, custom_project_name, isStarred, isArchived, user_id
                FROM projects
                WHERE project_id = ?
            `).get(projectId) as ProjectRepositoryRow | undefined;

        return row ?? null;
    },

    /**
     * Resolve the absolute project directory from a database project_id.
     *
     * This is the canonical lookup used after the projectName → projectId migration:
     * API routes receive the DB-assigned `projectId` and must resolve the real folder
     * path through this helper before touching the filesystem. Returns `null` when the
     * project row does not exist so callers can respond with a 404.
     */
    getProjectPathById(projectId: string, userId?: number): string | null {
        const db = getConnection();
        const row = userId != null
            ? db.prepare(`
                SELECT project_path
                FROM projects
                WHERE project_id = ? AND (user_id = ? OR user_id IS NULL)
            `).get(projectId, userId) as Pick<ProjectRepositoryRow, 'project_path'> | undefined
            : db.prepare(`
                SELECT project_path
                FROM projects
                WHERE project_id = ?
            `).get(projectId) as Pick<ProjectRepositoryRow, 'project_path'> | undefined;

        return row?.project_path ?? null;
    },

    getProjectPaths(userId?: number): ProjectRepositoryRow[] {
        const db = getConnection();
        if (userId != null) {
            return db.prepare(`
                SELECT project_id, project_path, custom_project_name, isStarred, isArchived, user_id
                FROM projects
                WHERE isArchived = 0 AND (user_id = ? OR user_id IS NULL)
            `).all(userId) as ProjectRepositoryRow[];
        }
        return db.prepare(`
            SELECT project_id, project_path, custom_project_name, isStarred, isArchived, user_id
            FROM projects
            WHERE isArchived = 0
        `).all() as ProjectRepositoryRow[];
    },

    /**
     * Archived rows are queried separately so archive-focused UIs can present
     * hidden workspaces without reintroducing them into the active sidebar list.
     */
    getArchivedProjectPaths(userId?: number): ProjectRepositoryRow[] {
        const db = getConnection();
        const rows = userId != null
            ? db.prepare(`
                SELECT project_id, project_path, custom_project_name, isStarred, isArchived, user_id
                FROM projects
                WHERE isArchived = 1 AND (user_id = ? OR user_id IS NULL)
            `).all(userId) as ProjectRepositoryRow[]
            : db.prepare(`
                SELECT project_id, project_path, custom_project_name, isStarred, isArchived, user_id
                FROM projects
                WHERE isArchived = 1
            `).all() as ProjectRepositoryRow[];
        return rows;
    },

    getCustomProjectName(projectPath: string): string | null {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        const row = db.prepare(`
            SELECT custom_project_name
            FROM projects
            WHERE project_path = ?
        `).get(normalizedProjectPath) as Pick<ProjectRepositoryRow, 'custom_project_name'> | undefined;

        return row?.custom_project_name ?? null;
    },

    updateCustomProjectName(projectPath: string, customProjectName: string | null, userId?: number): void {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        db.prepare(`
            INSERT INTO projects (project_id, project_path, custom_project_name, user_id)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(project_path) DO UPDATE SET custom_project_name = excluded.custom_project_name
        `).run(randomUUID(), normalizedProjectPath, customProjectName, userId ?? null);
    },

    updateCustomProjectNameById(projectId: string, customProjectName: string | null, userId?: number): void {
        const db = getConnection();
        if (userId != null) {
            db.prepare(`
                UPDATE projects
                SET custom_project_name = ?
                WHERE project_id = ? AND user_id = ?
            `).run(customProjectName, projectId, userId);
        } else {
            db.prepare(`
                UPDATE projects
                SET custom_project_name = ?
                WHERE project_id = ?
            `).run(customProjectName, projectId);
        }
    },

    updateProjectIsStarred(projectPath: string, isStarred: boolean): void {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        db.prepare(`
            UPDATE projects
            SET isStarred = ?
            WHERE project_path = ?
        `).run(isStarred ? 1 : 0, normalizedProjectPath);
    },

    updateProjectIsStarredById(projectId: string, isStarred: boolean, userId?: number): void {
        const db = getConnection();
        if (userId != null) {
            db.prepare(`
                UPDATE projects
                SET isStarred = ?
                WHERE project_id = ? AND user_id = ?
            `).run(isStarred ? 1 : 0, projectId, userId);
        } else {
            db.prepare(`
                UPDATE projects
                SET isStarred = ?
                WHERE project_id = ?
            `).run(isStarred ? 1 : 0, projectId);
        }
    },

    updateProjectIsArchived(projectPath: string, isArchived: boolean): void {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        db.prepare(`
            UPDATE projects
            SET isArchived = ?
            WHERE project_path = ?
        `).run(isArchived ? 1 : 0, normalizedProjectPath);
    },

    updateProjectIsArchivedById(projectId: string, isArchived: boolean, userId?: number): void {
        const db = getConnection();
        if (userId != null) {
            db.prepare(`
                UPDATE projects
                SET isArchived = ?
                WHERE project_id = ? AND user_id = ?
            `).run(isArchived ? 1 : 0, projectId, userId);
        } else {
            db.prepare(`
                UPDATE projects
                SET isArchived = ?
                WHERE project_id = ?
            `).run(isArchived ? 1 : 0, projectId);
        }
    },

    deleteProjectPath(projectPath: string): void {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        db.prepare(`
            DELETE FROM projects
            WHERE project_path = ?
        `).run(normalizedProjectPath);
    },

    deleteProjectById(projectId: string, userId?: number): void {
        const db = getConnection();
        if (userId != null) {
            db.prepare(`
                DELETE FROM projects
                WHERE project_id = ? AND user_id = ?
            `).run(projectId, userId);
        } else {
            db.prepare(`
                DELETE FROM projects
                WHERE project_id = ?
            `).run(projectId);
        }
    },
};
