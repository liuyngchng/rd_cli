import type { LLMProvider } from '../../types/app';
import ClaudeLogo from './ClaudeLogo';

type SessionProviderLogoProps = {
  provider?: LLMProvider | string | null;
  className?: string;
};

export default function SessionProviderLogo({
  provider = 'claude',
  className = 'w-5 h-5',
}: SessionProviderLogoProps) {
  return <ClaudeLogo className={className} />;
}
