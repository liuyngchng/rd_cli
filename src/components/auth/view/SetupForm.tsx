import { useCallback, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Lock, ShieldCheck, User } from 'lucide-react';

import { useAuth } from '../context/AuthContext';

import AuthErrorAlert from './AuthErrorAlert';
import AuthInputField from './AuthInputField';
import AuthScreenLayout from './AuthScreenLayout';

type SetupFormState = {
  username: string;
  password: string;
  confirmPassword: string;
};

const initialState: SetupFormState = {
  username: '',
  password: '',
  confirmPassword: '',
};

type SetupFormProps = {
  onSwitchToLogin?: () => void;
};

const REGISTER_ERROR_CODE_I18N_MAP: Record<string, string> = {
  AUTH_USERNAME_CONFLICT: 'register.errors.usernameTaken',
  AUTH_CREDENTIALS_REQUIRED: 'register.errors.requiredFields',
  AUTH_CREDENTIALS_TOO_SHORT: 'register.errors.usernameTooShort',
  AUTH_PASSWORD_TOO_SHORT: 'register.errors.passwordTooShort',
  AUTH_PASSWORD_WEAK: 'register.errors.weakPassword',
  RATE_LIMIT_EXCEEDED: 'register.errors.rateLimited',
};

/**
 * Account setup / registration form.
 * Uses `autoComplete="new-password"` on password fields so that password
 * managers recognise this as a registration flow and offer to save the new
 * credentials after submission.
 */
export default function SetupForm({ onSwitchToLogin }: SetupFormProps) {
  const { t } = useTranslation('auth');
  const { register } = useAuth();

  const [formState, setFormState] = useState<SetupFormState>(initialState);
  const [errorMessage, setErrorMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const updateField = useCallback((field: keyof SetupFormState, value: string) => {
    setFormState((previous) => ({ ...previous, [field]: value }));
  }, []);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setErrorMessage('');

      if (!formState.username.trim() || !formState.password || !formState.confirmPassword) {
        setErrorMessage(t('register.errors.requiredFields'));
        return;
      }

      if (formState.username.trim().length < 3) {
        setErrorMessage(t('register.errors.usernameTooShort'));
        return;
      }

      if (formState.password.length < 10) {
        setErrorMessage(t('register.errors.passwordTooShort'));
        return;
      }

      if (!/[A-Z]/.test(formState.password)) {
        setErrorMessage(t('register.errors.passwordNeedsUppercase'));
        return;
      }

      if (!/[a-z]/.test(formState.password)) {
        setErrorMessage(t('register.errors.passwordNeedsLowercase'));
        return;
      }

      if (!/[0-9]/.test(formState.password)) {
        setErrorMessage(t('register.errors.passwordNeedsDigit'));
        return;
      }

      if (formState.password !== formState.confirmPassword) {
        setErrorMessage(t('register.errors.passwordMismatch'));
        return;
      }

      setIsSubmitting(true);
      const result = await register(formState.username.trim(), formState.password);
      if (!result.success) {
        const i18nKey = result.errorCode ? REGISTER_ERROR_CODE_I18N_MAP[result.errorCode] : undefined;
        setErrorMessage(i18nKey ? t(i18nKey) : result.error);
      }
      setIsSubmitting(false);
    },
    [formState, register, t],
  );

  return (
    <AuthScreenLayout description={t('register.description')}>
      <form onSubmit={handleSubmit} className="space-y-3">
        <AuthInputField
          id="username"
          name="username"
          label={t('register.username')}
          value={formState.username}
          onChange={(value) => updateField('username', value)}
          placeholder={t('register.placeholders.username')}
          isDisabled={isSubmitting}
          autoComplete="username"
          icon={User}
        />

        <AuthInputField
          id="password"
          name="password"
          label={t('register.password')}
          value={formState.password}
          onChange={(value) => updateField('password', value)}
          placeholder={t('register.placeholders.password')}
          isDisabled={isSubmitting}
          type="password"
          autoComplete="new-password"
          icon={Lock}
        />

        <AuthInputField
          id="confirmPassword"
          name="confirmPassword"
          label={t('register.confirmPassword')}
          value={formState.confirmPassword}
          onChange={(value) => updateField('confirmPassword', value)}
          placeholder={t('register.placeholders.confirmPassword')}
          isDisabled={isSubmitting}
          type="password"
          autoComplete="new-password"
          icon={ShieldCheck}
        />

        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ShieldCheck className="h-3.5 w-3.5" />
          {t('register.hint')}
        </p>

        <AuthErrorAlert errorMessage={errorMessage} />

        <button
          type="submit"
          disabled={isSubmitting}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 font-medium text-primary-foreground shadow-lg shadow-primary/25 transition-all duration-200 hover:shadow-primary/30 hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-primary/40 focus:ring-offset-2 focus:ring-offset-card active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isSubmitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('register.loading')}
            </>
          ) : (
            t('register.submit')
          )}
        </button>
      </form>

      {onSwitchToLogin && (
        <p className="mt-4 text-center text-sm text-muted-foreground">
          {t('register.hasAccount')}{' '}
          <button
            type="button"
            onClick={onSwitchToLogin}
            className="font-medium text-primary hover:underline"
          >
            {t('register.goToLogin')}
          </button>
        </p>
      )}
    </AuthScreenLayout>
  );
}