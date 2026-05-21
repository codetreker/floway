import { withMessagesWebSearchShim, withMessagesWebSearchShimForTranslatedTargets } from './web-search-shim.ts';
import type { MessagesInterceptor } from '../../../interceptors.ts';

export const messagesSourceInterceptors = [withMessagesWebSearchShimForTranslatedTargets] satisfies readonly MessagesInterceptor[];

export const messagesWebSearchShimInterceptors = [withMessagesWebSearchShim] satisfies readonly MessagesInterceptor[];
