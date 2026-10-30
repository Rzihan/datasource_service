import { useEffect, useMemo, useState } from 'react';
import { App, Alert, Button, DatePicker, InputNumber, Select, Space, Switch, Tag, Typography } from 'antd';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';
import { ClearOutlined, SearchOutlined } from '@ant-design/icons';
import { setPrefs, usePrefs } from '../utils/prefs';
import type { CompareRequest, DatasetStats, FilterNode, OrderBy, QueryDataset } from '../types';
import DatasetTrustCard from './DatasetTrustCard';
import PresetAnalyses from './PresetAnalyses';
import FilterTreeEditor from './FilterTreeEditor';
import { countLeaves, emptyRoot, findRange, removeFields, stripRange, withRange } from '../utils/filterTree';

interface Props {
  datasets: QueryDataset[];
  selected: QueryDataset | null;
  onSelectDataset: (key: string) => void;
  dims: string[];
  metrics: string[];
  onDimsChange: (dims: string[]) => void;
  onMetricsChange: (metrics: string[]) => void;
  filterTree: FilterNode;
  onFilterTreeChange: (tree: FilterNode) => void;
  orderBy: OrderBy | null;
  onOrderByChange: (order: OrderBy | null) => void;
  limit: number;
  onLimitChange: (limit: number) => void;
  dimValues: Record<string, string[]>;
  dimValueLoading: Record<string, boolean>;
  onRequestDimValues: (field: string) => void;
  onExecute: () => void;
  loading: boolean;
  compare: CompareRequest | null;
  onCompareChange: (next: CompareRequest | null) => void;
  // 数据集体检报告：由查询页异步扫描后传进来
  stats?: DatasetStats | null;
  statsLoading?: boolean;
  onReloadStats?: () => void;
  // 打开作者预置的分析（query 就是 URL 里 ds 之后的那一段）
  onOpenPreset?: (query: string) => void;
  // 简洁档：字段下拉只显示名字（搜索仍命中口径）、预置分析收起、体检卡压成一行
  compact?: boolean;
}

export default function QueryBuilder(props: Props) {
  const {
    datasets, selected, onSelectDataset,
    dims, metrics, onDimsChange, onMetricsChange,
    filterTree, onFilterTreeChange,
    orderBy, onOrderByChange,
    limit, onLimitChange,
    dimValues, dimValueLoading, onRequestDimValues,
    onExecute, loading,
    compare, onCompareChange,
    stats, statsLoading, onReloadStats, onOpenPreset, compact,
  } = props;
  const { modal } = App.useApp();

  // 有中文含义就显示「中文（key）」，没有就退回 key
  const labelMap = selected?.label_map ?? {};
  const optionLabel = (k: string) => (labelMap[k] ? `${labelMap[k]}（${k}）` : k);

  // 数据集作者写的字段口径说明。查询页最常被问的「这个数是含税还是不含税」
  // 就靠它回答——写在数据集里，比写在 wiki 里被看到的机会大得多。
  const fieldNotes = selected?.meta?.field_notes ?? {};
  const noteOf = (k: string) => fieldNotes[k] ?? '';

  // 搜索要同时命中中文名、字段名和口径说明：
  // 用户可能记得「通过率」，也可能只记得「一次通过」。
  const matchField = (input: string, key: string) => {
    const q = input.trim().toLowerCase();
    if (!q) return true;
    return (
      key.toLowerCase().includes(q) ||
      (labelMap[key] ?? '').toLowerCase().includes(q) ||
      (fieldNotes[key] ?? '').toLowerCase().includes(q)
    );
  };

  // 每个选项两行：第一行是名字，第二行是口径说明（没有说明就不第二行）。
  // 下拉里直接看到单位与公式，比选完再去别处查文档省事。
  const renderOption = (option: { label?: unknown; value?: string | number }) => {
    const key = String(option.value ?? '');
    const note = noteOf(key);
    return (
      <div style={{ paddingBlock: 2 }}>
        <div>{option.label as React.ReactNode}</div>
        {/* 简洁档不显示口径说明这一行——但搜索仍然命中口径，
            因为「记得说明、记不住字段名」这种搜索需求与档位无关 */}
        {!compact && note && (
          <div style={{ fontSize: 12, color: '#8c8c8c', lineHeight: 1.4, whiteSpace: 'normal' }}>{note}</div>
        )}
      </div>
    );
  };

  // 多值维度也出现在维度下拉里——它本来就是维度，只是取值有多个。
  // 给它一个「多值」标记，否则用户会困惑为什么这一列长得跟别的维度不一样。
  const multiDimKeys = new Set(Object.keys(selected?.multi_dim_map ?? {}));
  const dimOptions = Object.keys(selected?.dim_map ?? {}).sort();
  const multiDimOptions = [...multiDimKeys].sort();
  const mtxOptions = Object.keys(selected?.mtx_map ?? {}).sort();
  const sortableOptions = [...dims, ...metrics];

  const selectedMultiDims = dims.filter((d) => multiDimKeys.has(d));

  // 只有已勾选的指标才能用来过滤：没勾选的指标不会出现在结果里，
  // 拿它做过滤条件用户看不到依据，语义上也说不通。
  const filterableMetrics = mtxOptions.filter((k) => metrics.includes(k));

  // 取消勾选指标时，挂在该指标上的过滤条件必须一起清掉，否则会提交一个
  // 用户看不懂的查询。清除前先弹确认，说明要动哪些东西。
  const handleMetricsChange = (next: string[]) => {
    const removed = metrics.filter((m) => !next.includes(m));
    const collected: string[] = [];
    const nextTree = removeFields(filterTree, removed, collected);
    const affectedSort = orderBy && removed.includes(orderBy.field) ? orderBy.field : '';
    if (collected.length === 0 && !affectedSort) {
      onMetricsChange(next);
      return;
    }

    const parts: string[] = [];
    if (collected.length > 0) {
      const names = [...new Set(collected)].map((m) => `「${optionLabel(m)}」`).join('、');
      parts.push(`指标 ${names} 上的 ${collected.length} 个过滤条件会被清除`);
    }
    if (affectedSort) {
      parts.push(`排序字段「${optionLabel(affectedSort)}」已失效，会被清空`);
    }

    modal.confirm({
      title: '取消勾选指标',
      content: `${parts.join('；')}。是否继续？`,
      okText: '继续',
      cancelText: '放弃',
      onOk: () => {
        onMetricsChange(next);
        if (collected.length > 0) {
          onFilterTreeChange(nextTree ?? emptyRoot());
        }
        if (affectedSort) onOrderByChange(null);
      },
    });
  };

  const leafCount = countLeaves(filterTree);

  // 时间范围：只在「看起来是日期」的维度存在时出现。
  // 判断靠字段名/中文名，不猜值——候选值要发请求才有，为一屏控件多打一轮请求不值得。
  const dateDimOptions = useMemo(() => {
    const rx = /(^|_)(date|dt|day|ts|time)($|_)/i;
    return dimOptions.filter((k) => rx.test(k) || /日期|时间|天/.test(labelMap[k] ?? ''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, labelMap]);

  const [rangeField, setRangeField] = useState('');
  useEffect(() => {
    if (dateDimOptions.length === 0) {
      if (rangeField) setRangeField('');
      return;
    }
    if (!dateDimOptions.includes(rangeField)) setRangeField(dateDimOptions[0]);
  }, [dateDimOptions, rangeField]);

  // 要知道数据最新到哪天：Relative「近 7 天」在 T+1 的数据上经常是空的，
  // 用户需要看到「数据只到 X」而不是对着空结果怀疑自己。
  useEffect(() => {
    if (rangeField) onRequestDimValues(rangeField);
  }, [rangeField, onRequestDimValues]);

  const dataDates = (dimValues[rangeField] ?? []).filter((v) => /^\d{4}-\d{2}-\d{2}$/.test(v));
  const dataMax = dataDates.length > 0 ? dataDates[dataDates.length - 1] : '';

  // 区间的唯一来源是条件树：清空条件、改条件都会同步反映到选择器上，
  // 不会出现「控件显示着区间、实际没提交」的两套真相。
  const range = rangeField ? findRange(filterTree, rangeField) : null;
  const rangeValue: [Dayjs, Dayjs] | null =
    range?.from && range.to ? [dayjs(range.from), dayjs(range.to)] : null;

  const presets = useMemo(() => {
    const now = dayjs();
    const list: Array<{ label: string; value: [Dayjs, Dayjs] }> = [
      { label: '近 7 天', value: [now.subtract(6, 'day'), now] },
      { label: '近 30 天', value: [now.subtract(29, 'day'), now] },
      { label: '本月', value: [now.startOf('month'), now] },
    ];
    if (dataMax && dataMax !== now.format('YYYY-MM-DD')) {
      const latest = dayjs(dataMax);
      list.push({ label: '数据最近 7 天', value: [latest.subtract(6, 'day'), latest] });
      list.push({ label: '数据最近 30 天', value: [latest.subtract(29, 'day'), latest] });
    }
    return list;
  }, [dataMax]);

  const applyRange = (next: [Dayjs, Dayjs] | null) => {
    if (!rangeField) return;
    if (!next) {
      onFilterTreeChange(stripRange(filterTree, rangeField) ?? emptyRoot());
      return;
    }
    onFilterTreeChange(
      withRange(filterTree, rangeField, next[0].format('YYYY-MM-DD'), next[1].format('YYYY-MM-DD')),
    );
  };

  // 高级区默认开合：跟着档位走（简洁档收起），手动切换后写进偏好——
  // 每天都要手动收一次的东西，等于没收。
  const prefs = usePrefs();
  const [advOpen, setAdvOpen] = useState(prefs.advancedOpen ?? !compact);
  useEffect(() => setAdvOpen(prefs.advancedOpen ?? !compact), [compact, prefs.advancedOpen]);
  const toggleAdvanced = () => {
    const next = !advOpen;
    setAdvOpen(next);
    setPrefs({ advancedOpen: next });
  };

  // 收起时必须说清「里面有几项在生效」：折叠区里藏着生效条件，
  // 是最容易让人以为「我筛过了但没生效 / 我没筛但被筛了」的设计。
  const advancedActive: string[] = [];
  if (rangeValue) advancedActive.push(`时间范围 ${rangeValue[0].format('YYYY-MM-DD')} ~ ${rangeValue[1].format('YYYY-MM-DD')}`);
  if (compare) advancedActive.push(compare.mode === 'prev_year' ? '同比' : '环比');
  if (orderBy) advancedActive.push(`按${optionLabel(orderBy.field)}${orderBy.desc ? '降序' : '升序'}`);
  if (limit !== 1000) advancedActive.push(`上限 ${limit}`);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          数据集
        </Typography.Text>
        <Select
          style={{ width: '100%', marginTop: 4 }}
          placeholder="选择数据集"
          value={selected?.dataset_key}
          onChange={onSelectDataset}
          options={datasets.map((d) => ({
            value: d.dataset_key,
            label: `${d.dataset_key} · ${d.dataset_name}`,
          }))}
        />
        {/* 数据集的可信度：描述 + 行数 + 覆盖区间 + 负责人 + 更新频率。
            选完数据集立刻看到，不用先查一次才知道这数据能不能用。 */}
        <DatasetTrustCard
          dataset={selected}
          stats={stats ?? null}
          loading={statsLoading}
          onReload={onReloadStats}
          compact={compact}
        />
        {/* 作者预置的分析：新人接手时的第一个问题是「从哪儿开始看」，
            而这个问题数据集作者心里有答案，现在它是数据集的一部分。 */}
        <PresetAnalyses
          examples={selected?.meta?.examples ?? []}
          defaultQuery={selected?.meta?.default_example}
          onOpen={onOpenPreset ?? (() => {})}
          compact={compact}
        />
      </div>

      <div>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          维度
        </Typography.Text>
        <Select
          mode="multiple"
          style={{ width: '100%', marginTop: 4 }}
          placeholder={selected ? '选择维度（可搜索字段名或口径）' : '请先选择数据集'}
          disabled={!selected}
          value={dims}
          onChange={onDimsChange}
          showSearch
          filterOption={(input, option) =>
            matchField(input, String((option as { value?: unknown } | undefined)?.value ?? ''))
          }
          optionRender={renderOption}
          options={[
            ...(dimOptions.length > 0
              ? [
                  {
                    label: `维度（${dimOptions.length}）`,
                    options: dimOptions.map((k) => ({ value: k, label: optionLabel(k) })),
                  },
                ]
              : []),
            ...(multiDimOptions.length > 0
              ? [
                  {
                    label: `多值维度（${multiDimOptions.length}）· 收拢展示`,
                    options: multiDimOptions.map((k) => ({
                      value: k,
                      label: (
                        <Space size={4}>
                          {optionLabel(k)}
                          <Tag color="purple" style={{ marginInlineEnd: 0 }}>
                            多值
                          </Tag>
                        </Space>
                      ),
                    })),
                  },
                ]
              : []),
          ]}
        />
        {selectedMultiDims.length > 0 && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {selectedMultiDims.map((d) => optionLabel(d)).join('、')} 是收拢展示的：
            同一分组下的多个取值会去重排序后拼成一个值（如「公司A,公司B」），不会按取值拆成多行。
            用「包含」类条件过滤时，先筛行再收拢——
            所以筛「包含公司A」看到的仍是这些行的全部公司，指标也只统计这些行。
          </Typography.Text>
        )}
      </div>

      <div>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          指标
        </Typography.Text>
        <Select
          mode="multiple"
          style={{ width: '100%', marginTop: 4 }}
          placeholder={selected ? '选择指标（可搜索字段名或口径）' : '请先选择数据集'}
          disabled={!selected}
          value={metrics}
          onChange={handleMetricsChange}
          showSearch
          filterOption={(input, option) =>
            matchField(input, String((option as { value?: unknown } | undefined)?.value ?? ''))
          }
          optionRender={renderOption}
          options={[
            {
              label: `指标（${mtxOptions.length}）`,
              options: mtxOptions.map((k) => ({ value: k, label: optionLabel(k) })),
            },
          ]}
        />
      </div>

      <div>
        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            过滤条件{leafCount > 0 ? `（${leafCount} 个）` : ''}
          </Typography.Text>
          {leafCount > 0 && (
            <Button
              type="link"
              size="small"
              icon={<ClearOutlined />}
              onClick={() => onFilterTreeChange(emptyRoot())}
            >
              清空
            </Button>
          )}
        </Space>
        <div style={{ marginTop: 4 }}>
          <FilterTreeEditor
            node={filterTree}
            onChange={onFilterTreeChange}
            depth={1}
            dimOptions={dimOptions}
            multiDimOptions={multiDimOptions}
            metricOptions={filterableMetrics}
            isMetricField={(field) => mtxOptions.includes(field)}
            optionLabel={optionLabel}
            dimValues={dimValues}
            dimValueLoading={dimValueLoading}
            onRequestDimValues={onRequestDimValues}
          />
        </div>
      </div>

      {/* 高级区：这四块都不是「每次都要改」的——时间范围、对比周期、排序、上限。
          默认收起，但收起时必须说清里面有几项在生效，否则用户会以为自己没筛过。 */}
      <div>
        <Space size={6} style={{ cursor: 'pointer' }} onClick={toggleAdvanced}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            高级：时间范围 / 对比周期 / 排序 / 上限
          </Typography.Text>
          {advancedActive.length > 0 && <Tag color="blue">{advancedActive.length} 项生效</Tag>}
          <Typography.Link style={{ fontSize: 12 }} onClick={(e) => { e.stopPropagation(); toggleAdvanced(); }}>
            {advOpen ? '收起' : '展开'}
          </Typography.Link>
        </Space>
        {!advOpen && advancedActive.length > 0 && (
          <div style={{ fontSize: 12, color: 'rgba(0,0,0,0.45)', marginTop: 2 }}>{advancedActive.join(' · ')}</div>
        )}
        {advOpen && (
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 14 }}>
      {dateDimOptions.length > 0 && (
        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            时间范围
          </Typography.Text>
          <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Select
              style={{ width: '100%' }}
              value={rangeField || undefined}
              options={dateDimOptions.map((k) => ({ value: k, label: optionLabel(k) }))}
              onChange={(v) => {
                // 换日期字段时把旧字段上的区间带走，否则会留下一条看不见的条件
                onFilterTreeChange(stripRange(filterTree, rangeField) ?? emptyRoot());
                setRangeField(v);
                onRequestDimValues(v);
              }}
            />
            <DatePicker.RangePicker
              style={{ width: '100%' }}
              value={rangeValue}
              presets={presets}
              allowClear
              placeholder={['开始日期', '结束日期']}
              onChange={(v) => applyRange(v && v[0] && v[1] ? [v[0], v[1]] : null)}
            />
            {dataMax && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                数据最新到 {dataMax}
                {dataMax !== dayjs().format('YYYY-MM-DD') ? '，相对今天的区间可能查不到数据' : ''}
              </Typography.Text>
            )}
          </div>
        </div>
      )}

      {dateDimOptions.length > 0 && (
        <div>
          <Space style={{ width: '100%', justifyContent: 'space-between' }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              对比周期
            </Typography.Text>
            <Switch
              size="small"
              checked={!!compare}
              disabled={metrics.length === 0}
              onChange={(on) =>
                onCompareChange(on ? { mode: 'prev_period', field: rangeField || dateDimOptions[0] } : null)
              }
            />
          </Space>
          {metrics.length === 0 && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              对比需要至少一个指标
            </Typography.Text>
          )}
          {compare && (
            <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <Select
                style={{ width: '100%' }}
                value={compare.mode}
                onChange={(v) => onCompareChange({ ...compare, mode: v })}
                options={[
                  { value: 'prev_period', label: '上一个等长周期（环比）' },
                  { value: 'prev_year', label: '去年同期（同比）' },
                ]}
              />
              <Select
                style={{ width: '100%' }}
                value={compare.field}
                onChange={(v) => onCompareChange({ ...compare, field: v })}
                options={dateDimOptions.map((k) => ({ value: k, label: optionLabel(k) }))}
              />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {range
                  ? `本期 ${range.from} ~ ${range.to}，服务端按同一口径再查一次上期`
                  : '未设时间范围时会先探测数据覆盖区间，再按同一口径查上期'}
                ；结果被截断时不给对比，避免漏掉分组算出错的变化率。
              </Typography.Text>
            </div>
          )}
        </div>
      )}

      <div>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          排序
        </Typography.Text>
        <Space.Compact style={{ width: '100%', marginTop: 4 }}>
          <Select
            style={{ width: '60%' }}
            allowClear
            placeholder="字段（维度或指标）"
            value={orderBy?.field}
            options={sortableOptions.map((k) => ({ value: k, label: optionLabel(k) }))}
            onChange={(v) => onOrderByChange(v ? { field: v, desc: orderBy?.desc ?? true } : null)}
          />
          <Select
            style={{ width: '40%' }}
            value={orderBy?.desc ? 'desc' : 'asc'}
            onChange={(v) => orderBy && onOrderByChange({ ...orderBy, desc: v === 'desc' })}
            options={[
              { value: 'desc', label: '降序' },
              { value: 'asc', label: '升序' },
            ]}
          />
        </Space.Compact>
      </div>

      <div>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          返回行数（上限 10000）
        </Typography.Text>
        <InputNumber
          style={{ width: '100%', marginTop: 4 }}
          min={1}
          max={10000}
          value={limit}
          onChange={(v) => onLimitChange(v ?? 1000)}
        />
      </div>

          </div>
        )}
      </div>

      {!selected && <Alert type="info" showIcon message="先选择一个数据集" />}

      <Button
        type="primary"
        icon={<SearchOutlined />}
        loading={loading}
        disabled={!selected || (dims.length === 0 && metrics.length === 0)}
        onClick={onExecute}
      >
        查数
      </Button>
    </div>
  );
}
