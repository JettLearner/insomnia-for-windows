import type { InsomniazApi } from '../shared/types';

declare global {
  interface Window {
    insomniaz?: InsomniazApi;
    __insomniazBootError?: string;
  }
}

export {};
