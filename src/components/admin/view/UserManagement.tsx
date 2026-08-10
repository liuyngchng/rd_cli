import { useCallback, useEffect, useState } from 'react';
import { Loader2, Plus, Shield, UserX, UserCheck, Users } from 'lucide-react';
import { useAuth } from '../../auth/context/AuthContext';
import { api } from '../../../utils/api';

type UserRow = {
  id: number;
  username: string;
  role: string;
  created_at: string;
  last_login: string | null;
  is_active: number;
};

type CreateUserForm = {
  username: string;
  password: string;
};

export default function UserManagement() {
  const { user } = useAuth();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createForm, setCreateForm] = useState<CreateUserForm>({ username: '', password: '' });
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  const fetchUsers = useCallback(async () => {
    try {
      setIsLoading(true);
      setError('');
      const response = await api.admin.listUsers();
      if (!response.ok) {
        setError('Failed to load users');
        return;
      }
      const payload = await response.json() as { users?: UserRow[] };
      setUsers(payload.users ?? []);
    } catch {
      setError('Network error loading users');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchUsers();
  }, [fetchUsers]);

  const handleCreateUser = useCallback(async () => {
    if (!createForm.username.trim() || !createForm.password) {
      setCreateError('Username and password are required');
      return;
    }
    if (createForm.username.length < 3 || createForm.password.length < 6) {
      setCreateError('Username must be at least 3 characters, password at least 6 characters');
      return;
    }

    try {
      setIsCreating(true);
      setCreateError('');
      const response = await api.admin.createUser(createForm.username.trim(), createForm.password);
      if (!response.ok) {
        const payload = await response.json() as { error?: string };
        setCreateError(payload.error ?? 'Failed to create user');
        return;
      }
      setShowCreateForm(false);
      setCreateForm({ username: '', password: '' });
      await fetchUsers();
    } catch {
      setCreateError('Network error creating user');
    } finally {
      setIsCreating(false);
    }
  }, [createForm, fetchUsers]);

  const handleToggleActive = useCallback(async (userId: number, currentActive: boolean) => {
    try {
      const response = await api.admin.setUserActive(userId, !currentActive);
      if (response.ok) {
        setUsers((prev) =>
          prev.map((u) => (u.id === userId ? { ...u, is_active: currentActive ? 0 : 1 } : u)),
        );
      }
    } catch {
      // silently fail — the UI will revert on next fetch
    }
  }, []);

  if (user?.role !== 'admin') {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="text-center">
          <Shield className="mx-auto h-12 w-12 text-muted-foreground/40" />
          <p className="mt-4 text-sm text-muted-foreground">Admin access required</p>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-6 py-4">
        <div className="flex items-center gap-2">
          <Users className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">User Management</h1>
        </div>
        <button
          onClick={() => setShowCreateForm(true)}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:brightness-110"
        >
          <Plus className="h-4 w-4" />
          Add User
        </button>
      </div>

      {error && (
        <div className="mx-6 mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-400">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-auto p-6">
        <div className="overflow-hidden rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Username</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Role</th>
                <th className="hidden px-4 py-3 text-left font-medium text-muted-foreground md:table-cell">Created</th>
                <th className="hidden px-4 py-3 text-left font-medium text-muted-foreground md:table-cell">Last Login</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Status</th>
                <th className="px-4 py-3 text-right font-medium text-muted-foreground">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-b border-border last:border-0 hover:bg-muted/30">
                  <td className="px-4 py-3 font-medium">{u.username}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                      u.role === 'admin' ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400' : 'bg-muted text-muted-foreground'
                    }`}>
                      {u.role}
                    </span>
                  </td>
                  <td className="hidden px-4 py-3 text-muted-foreground md:table-cell">
                    {u.created_at ? new Date(u.created_at).toLocaleDateString() : '—'}
                  </td>
                  <td className="hidden px-4 py-3 text-muted-foreground md:table-cell">
                    {u.last_login ? new Date(u.last_login).toLocaleDateString() : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                      u.is_active ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                    }`}>
                      {u.is_active ? 'Active' : 'Disabled'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {u.id !== user?.id && (
                      <button
                        onClick={() => handleToggleActive(u.id, Boolean(u.is_active))}
                        className={`inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                          u.is_active
                            ? 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30'
                            : 'text-green-600 hover:bg-green-50 dark:text-green-400 dark:hover:bg-green-950/30'
                        }`}
                      >
                        {u.is_active ? (
                          <><UserX className="h-3.5 w-3.5" /> Disable</>
                        ) : (
                          <><UserCheck className="h-3.5 w-3.5" /> Enable</>
                        )}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {users.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-muted-foreground">
                    No users found
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create User Modal */}
      {showCreateForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-xl">
            <h2 className="mb-4 text-lg font-semibold">Create New User</h2>
            {createError && (
              <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-400">
                {createError}
              </div>
            )}
            <div className="space-y-4">
              <div>
                <label htmlFor="new-username" className="mb-1 block text-sm font-medium">Username</label>
                <input
                  id="new-username"
                  type="text"
                  value={createForm.username}
                  onChange={(e) => setCreateForm((prev) => ({ ...prev, username: e.target.value }))}
                  className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
                  placeholder="Enter username"
                  autoComplete="off"
                />
              </div>
              <div>
                <label htmlFor="new-password" className="mb-1 block text-sm font-medium">Password</label>
                <input
                  id="new-password"
                  type="password"
                  value={createForm.password}
                  onChange={(e) => setCreateForm((prev) => ({ ...prev, password: e.target.value }))}
                  className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
                  placeholder="Enter password"
                  autoComplete="new-password"
                />
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={() => {
                  setShowCreateForm(false);
                  setCreateError('');
                }}
                className="rounded-lg border border-border px-4 py-2 text-sm transition-colors hover:bg-muted"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateUser}
                disabled={isCreating}
                className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isCreating ? (
                  <><Loader2 className="h-4 w-4 animate-spin" /> Creating...</>
                ) : (
                  'Create User'
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}