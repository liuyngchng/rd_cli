import { useEffect, useState, type ReactNode } from 'react';
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

  // 组件挂载即通知 Electron 主进程：React 已启动（不等 auth 请求完成）。
  // mainWindow 的 paintWhenInitiallyHidden:true  + backgroundThrottling:false
  // 确保隐藏期间 Chromium 持续绘制，show() 的第一帧就是已渲染好的界面。
  // 主窗口本来 hidden（show: false），用户看不到这个 loading 画面 —— splash
  // 会一直挡到 tryReveal() 两路信号到齐。
  useEffect(() => {
    notifyDesktopReady();
  }, []);

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
