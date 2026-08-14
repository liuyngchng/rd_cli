type PiLogoProps = {
  className?: string;
};

const PiLogo = ({ className = 'w-5 h-5' }: PiLogoProps) => (
  <svg
    viewBox="0 0 24 24"
    role="img"
    aria-label="Pi"
    className={className}
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <rect x="2" y="2" width="20" height="20" rx="5" className="fill-foreground" />
    <path
      d="M7 17V7h4.5a3 3 0 0 1 0 6H8.5M7 17h1.5l3-6"
      className="stroke-background"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M14 7h3M14 7v10"
      className="stroke-background"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export default PiLogo;