import type { LLMProvider } from '../../types/app';
import PiLogo from './PiLogo';

type SessionProviderLogoProps = {
  provider?: LLMProvider | string | null;
  className?: string;
};

export default function SessionProviderLogo({
  provider = 'pi',
  className = 'w-5 h-5',
}: SessionProviderLogoProps) {
  return <PiLogo className={className} />;
}
