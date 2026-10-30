import { useEffect, useState } from 'react';
import { Typography } from 'antd';
import type { MetaExample } from '../types';

interface Props {
  examples: MetaExample[];
  // 作者指定的默认视图（某条 example 的 query）：排在最前并标注，
  // 十条预置平铺等于没有重点
  defaultQuery?: string;
  onOpen: (query: string) => void;
  // 简洁档默认收成一行：老手多半已经知道自己要看什么，
  // 四条「作者建议」每天挡在下拉下面，是纯噪音。收起不等于删掉，点一下还在。
  compact?: boolean;
}

// 数据集作者把「这张表该怎么用」钉在看板上。
// 新人接手时的第一个问题永远是「从哪儿开始看」，而这个问题作者心里有答案——
// 以前它只在作者的脑子里或者周报模板里，现在它是数据集的一部分。
export default function PresetAnalyses({ examples, defaultQuery, onOpen, compact }: Props) {
  const [open, setOpen] = useState(!compact);
  // 切档位要立刻生效：否则从完整档切到简洁档，预置分析还摊在那里，
  // 用户会以为开关坏了。手动展开/收起只在这次档位内有效。
  useEffect(() => setOpen(!compact), [compact]);
  if (examples.length === 0) return null;
  // 默认视图排最前：作者指定的那条要第一眼看到
  const ordered = defaultQuery
    ? [...examples].sort((a, b) => (a.query === defaultQuery ? -1 : b.query === defaultQuery ? 1 : 0))
    : examples;
  return (
    <div style={{ marginTop: 10 }}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        作者预置的分析（{examples.length}）
        {!open && (
          <Typography.Link style={{ fontSize: 12, marginLeft: 6 }} onClick={() => setOpen(true)}>
            展开
          </Typography.Link>
        )}
        {open && compact && (
          <Typography.Link style={{ fontSize: 12, marginLeft: 6 }} onClick={() => setOpen(false)}>
            收起
          </Typography.Link>
        )}
      </Typography.Text>
      {open && (
      <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {ordered.map((e) => (
          <div key={e.title}>
            <Typography.Link style={{ fontSize: 13 }} onClick={() => onOpen(e.query)}>
              {e.title}
            </Typography.Link>
            {e.query === defaultQuery && (
              <span style={{ fontSize: 11, color: '#d48806', marginLeft: 6 }}>作者默认</span>
            )}
            {e.note && (
              <div style={{ fontSize: 11, color: 'rgba(0,0,0,0.45)', lineHeight: '16px' }}>{e.note}</div>
            )}
          </div>
        ))}
      </div>
      )}
    </div>
  );
}
