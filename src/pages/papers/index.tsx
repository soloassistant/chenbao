/**
 * pages/papers —— 历年真题库（独立页）。
 *
 * ⚠️ 真题库主体已并入题库页（pages/questionBank 的「历年真题」tab）。
 * 本页保留只是为了不让旧链接死掉 —— 两边渲染**同一个组件**（components/PaperLibrary），
 * 不存在两份实现，也就不会分叉。
 */
import { View } from '@tarojs/components';
import PaperLibrary from '@/components/PaperLibrary';
import { useT } from '@/store/language';
import { brandVars, useThemeStore } from '@/store/theme';
import { startMockExam } from '@/utils/mockExamNav';

export default function PapersPage() {
  const t = useT();
  const { theme } = useThemeStore();

  return (
    <View style={brandVars(theme)}>
      <PaperLibrary
        showHeader
        onStartMock={({ binding, title, tags }) =>
          startMockExam(
            { title, examSystem: binding.examSystem, subject: binding.subject, tags },
            t('mock.startFailed')
          )
        }
      />
    </View>
  );
}
