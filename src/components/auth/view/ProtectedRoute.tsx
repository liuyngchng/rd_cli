import { useEffect, useRef, useState, type ReactNode } from 'react';
import { IS_PLATFORM } from '../../../constants/config';
import { useAuth } from '../context/AuthContext';
import Onboarding from '../../onboarding/view/Onboarding';
import AuthLoadingScreen from './AuthLoadingScreen';
import LoginForm from './LoginForm';
import SetupForm from './SetupForm';

type ProtectedRouteProps = {
  children: ReactNode;
};

/**
 * 通知 Electron 桌面端：React 应用界面已准备就绪，可以关闭 splash 并显示主窗口。
 * 在浏览器或开发模式下，该方法不存在，调用安全无害（no-op）。
 */
function notifyDesktopReady() {
  try {
    const api = (window as any).rdcliDesktopNotifications;
    if (api?.notifyReady) {
      api.notifyReady();
    }
  } catch {
    // 静默忽略 — 非桌面环境或 preload 未暴露此 API
  }
}

export default function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { user, isLoading, hasCompletedOnboarding, refreshOnboardingStatus } = useAuth();
  const [authView, setAuthView] = useState<'login' | 'register'>('login');
  const readyNotifiedRef = useRef(false);

  // 当 auth 状态加载完成、界面已渲染（登录/设置/主内容）时，通知 Electron 切换窗口。
  useEffect(() => {
    if (!isLoading && !readyNotifiedRef.current) {
      readyNotifiedRef.current = true;
      // 延迟一帧确保 React 已提交 DOM，让用户第一眼看到的就是完整界面
      requestAnimationFrame(() => notifyDesktopReady());
    }
  }, [isLoading]);

  if (isLoading) {
    return <AuthLoadingScreen />;
  }

  if (IS_PLATFORM) {
    if (!hasCompletedOnboarding) {
      return <Onboarding onComplete={refreshOnboardingStatus} />;
    }

    return <>{children}</>;
  }

  if (!user) {
    return authView === 'register'
      ? <SetupForm onSwitchToLogin={() => setAuthView('login')} />
      : <LoginForm onSwitchToRegister={() => setAuthView('register')} />;
  }

  if (!hasCompletedOnboarding) {
    return <Onboarding onComplete={refreshOnboardingStatus} />;
  }

  return <>{children}</>;
}
