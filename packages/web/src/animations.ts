import type { Variants } from 'framer-motion';

export const paneAppear: Variants = {
  hidden: { opacity: 0, scale: 0.95, y: 8 },
  visible: (i: number = 0) => ({
    opacity: 1,
    scale: 1,
    y: 0,
    transition: { duration: 0.3, ease: 'easeOut', delay: i * 0.1 },
  }),
  exit: { opacity: 0, scale: 0.95, transition: { duration: 0.2 } },
};

export const slideIn: Variants = {
  hidden: { opacity: 0, x: 16 },
  visible: { opacity: 1, x: 0, transition: { duration: 0.2, ease: 'easeOut' } },
  exit: { opacity: 0, x: -16, transition: { duration: 0.15 } },
};

export const fadeIn: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: 0.2 } },
  exit: { opacity: 0, transition: { duration: 0.15 } },
};

export const chatMessageAppear: Variants = {
  hidden: { opacity: 0, y: 8 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.2, ease: 'easeOut' } },
};

export const thinkingPulse: Variants = {
  animate: {
    borderColor: ['rgba(99, 102, 241, 0.2)', 'rgba(99, 102, 241, 0.6)', 'rgba(99, 102, 241, 0.2)'],
    transition: { duration: 2, ease: 'easeInOut', repeat: Infinity },
  },
};
