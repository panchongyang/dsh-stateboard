// Page-scoped React context fences writes against navigation; transport has no navigation policy.
import React from 'react';
import type { ProjectNavigation } from '../model/types.ts';
const useCallback = React.useCallback;

// Each page provides its own owner; shared transport has no navigation policy.
export interface PageWriteScope { navigation: ProjectNavigation; projectId: string; selectionVersion: number }
export const PageNavigationContext = React.createContext<PageWriteScope | null>(null);
export function usePageWrite<A extends unknown[], R>(write: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  const scope = React.useContext(PageNavigationContext);
  return useCallback(async function () {
    if (!scope) throw new Error('编辑页面尚未就绪，请重新打开项目页面。');
    scope.navigation.assertWritable(scope.projectId, scope.selectionVersion);
    // The returned signature fixes this arguments object to the original write tuple.
    return write.apply(null, arguments as unknown as A);
  }, [scope, write]);
}
