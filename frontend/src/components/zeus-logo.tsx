interface ZeusLogoProps {
  size?: number;
  className?: string;
  showText?: boolean;
  textSize?: string;
}

export function ZeusLogoIcon({ size = 32, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      {/* Shield body */}
      <path
        d="M20 2L38 9V24C38 34.5 30 42.5 20 46C10 42.5 2 34.5 2 24V9L20 2Z"
        fill="#0f1623"
        stroke="#F5A623"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      {/* Inner shield glow */}
      <path
        d="M20 6L34 11.5V24C34 32.5 27.5 39 20 42C12.5 39 6 32.5 6 24V11.5L20 6Z"
        fill="#F5A623"
        fillOpacity="0.07"
      />
      {/* Lightning bolt — stylized Z shape */}
      <path
        d="M24 11H15L13 23H19L16 37L27 21H21L24 11Z"
        fill="#F5A623"
        stroke="#F5A623"
        strokeWidth="0.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ZeusLogo({ size = 32, showText = true, textSize = 'text-xl', className = '' }: ZeusLogoProps) {
  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <ZeusLogoIcon size={size} />
      {showText && (
        <span className={`font-brand font-bold tracking-wider text-primary ${textSize}`}>
          ZEUS
        </span>
      )}
    </div>
  );
}
