import { Typography } from 'antd';
import type { MetaExample } from '../types';

interface Props {
  examples: MetaExample[];
  onOpen: (query: string) => void;
}

// 数据集作者把「这张表该怎么用」钉在看板上。
// 新人接手时的第一个问题永远是「从哪儿开始看」，而这个问题作者心里有答案——
// 以前它只在作者的脑子里或者周报模板里，现在它是数据集的一部分。
export default function PresetAnalyses({ examples, onOpen }: Props) {
  if (examples.length === 0) return null;
  return (
    <div style={{ marginTop: 10 }}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        作者预置的分析（{examples.length}）
      </Typography.Text>
      <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {examples.map((e) => (
          <div key={e.title}>
            <Typography.Link style={{ fontSize: 13 }} onClick={() => onOpen(e.query)}>
              {e.title}
            </Typography.Link>
            {e.note && (
              <div style={{ fontSize: 11, color: 'rgba(0,0,0,0.45)', lineHeight: '16px' }}>{e.note}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
