package query

import (
	"context"
	"log/slog"
	"regexp"
	"sort"
	"strings"

	"dataset_service/internal/model"
)

// 这个文件解决的是「存量配置怎么办」。
//
// multi_dim_map 是这一轮才有的字段类型，而多值维度早就存在——
// 它们被塞在 mtx_map 里当指标顶着（dim_map 放不下，因为不能进 GROUP BY）。
// 光给出正确的地方不够，还得把已经配错的那些找出来、并给出一条不手抄的迁移路径。

// arrayFuncPattern 匹配「表达式里用了数组相关函数」。
// 长名排在前面：正则的分支是从左往右试的，否则 groupArray 会先吃掉 groupUniqArrayArray。
var arrayFuncPattern = regexp.MustCompile(`(?i)\b(` +
	`groupUniqArrayArray|groupUniqArray|groupArray|arrayStringConcat|` +
	`arrayDistinct|arraySort|arrayFilter|arrayMap|arrayJoin|arrayReduce` +
	`)\s*\(`)

// CheckMultiDim 扫描全部数据集，挑出「疑似多值维度但没配在 multi_dim_map 里」的字段。
//
// 两条判据，命中任意一条就列出来：
//  1. mid_sql 输出的这一列本身就是数组类型（拿真实数仓的列元信息判断，最准）
//  2. 表达式里用了数组函数（拿不到列类型时也能提示，比如表达式是 groupArray(...)）
//
// 为什么不能只靠判据 2：正则只能识别常见写法，且 groupArray(x) 也可能是
// 有意要的指标。反过来只靠判据 1 又会漏掉表达式改造过的字段。
// 所以两条都列出来，理由写清楚是哪条命中的，由人决定迁不迁。
//
// 结果只是「建议」，不会自动改任何配置——一个字段算不算多值维度是业务判断。
func (s *Service) CheckMultiDim(ctx context.Context) (*model.MultiDimCheckResult, error) {
	items, err := s.repo.ListAvailable(ctx, 0)
	if err != nil {
		return nil, err
	}
	res := &model.MultiDimCheckResult{
		Candidates:   []model.MultiDimCandidate{},
		DatasetCount: len(items),
	}

	for _, it := range items {
		colTypes, err := s.midColumnTypes(ctx, it)
		if err != nil {
			// 跑不通就跳过这个数据集，不让它拖垮整次扫描
			slog.Warn("multi-dim check: skip dataset, mid_sql not runnable",
				"dataset_key", it.DatasetKey, "error", err)
			continue
		}
		res.Scanned++
		res.Candidates = append(res.Candidates, scanMultiDim(it.DatasetKey, it.MtxMap, "mtx_map", colTypes)...)
		res.Candidates = append(res.Candidates, scanMultiDim(it.DatasetKey, it.DimMap, "dim_map", colTypes)...)
	}

	sort.Slice(res.Candidates, func(i, j int) bool {
		if res.Candidates[i].DatasetKey != res.Candidates[j].DatasetKey {
			return res.Candidates[i].DatasetKey < res.Candidates[j].DatasetKey
		}
		return res.Candidates[i].FieldKey < res.Candidates[j].FieldKey
	})
	return res, nil
}

// midColumnTypes 跑一次 mid_sql 拿它实际输出列的类型。
//
// 只要列元信息，不要数据：LIMIT 1 由 BuildDryRunMidSQL 保证。
// 模板按「全部字段都要用」渲染，否则可能拿不到某些 JOIN 分支里的列。
func (s *Service) midColumnTypes(ctx context.Context, ds *model.DatasetConfig) (map[string]string, error) {
	dimKeys := keysOf(ds.DimMap)
	multiKeys := keysOf(ds.MultiDimMap)
	mtxKeys := keysOf(ds.MtxMap)
	all := append(append([]string{}, dimKeys...), multiKeys...)
	all = append(all, mtxKeys...)

	rendered, err := RenderMidSQL(ds.MidSQL, MidSQLData{
		Dims:    dedupSorted(append(append([]string{}, dimKeys...), multiKeys...)),
		Metrics: dedupSorted(mtxKeys),
		Fields:  dedupSorted(all),
	})
	if err != nil {
		return nil, err
	}
	queryCtx, cancel := context.WithTimeout(ctx, s.timeout)
	defer cancel()
	res, err := s.engine.Query(queryCtx, BuildDryRunMidSQL(rendered), nil)
	if err != nil {
		return nil, err
	}
	out := make(map[string]string, len(res.Columns))
	for _, c := range res.Columns {
		out[c.Name] = c.Type
	}
	return out, nil
}

// scanMultiDim 在一份 map 里找疑似多值维度的字段。
func scanMultiDim(datasetKey string, m map[string]string, from string, colTypes map[string]string) []model.MultiDimCandidate {
	out := make([]model.MultiDimCandidate, 0, len(m))
	for k, raw := range m {
		expr := strings.TrimSpace(raw)
		reason := arrayFieldReason(expr, colTypes)
		if reason == "" {
			continue
		}
		if from == "dim_map" {
			// 普通维度会进 GROUP BY，多值字段放这儿是按取值拆行，比当指标更糟
			reason += "；配成普通维度会进 GROUP BY，一行会被拆成多行"
		}
		suggest := stripCollectShell(expr)
		out = append(out, model.MultiDimCandidate{
			DatasetKey:  datasetKey,
			FieldKey:    k,
			From:        from,
			Expr:        expr,
			Reason:      reason,
			SuggestExpr: suggest,
			// 只有能确认建议表达式真的产出数组时，才给一键迁移的资格
			Confident: isBareIdent(suggest) && strings.Contains(strings.ToUpper(colTypes[suggest]), "ARRAY("),
		})
	}
	return out
}

// stripCollectShell 剥掉「已经是收拢表达式」的外壳，只留内层产出数组的表达式。
//
// 以前多值维度只能塞进 mtx_map，写法通常就是完整收拢式
// arrayStringConcat(arraySort(groupUniqArrayArray(companies)), ',')。
// 原样搬进 multi_dim_map 会被再包一层收拢，变成对字符串做 groupUniqArrayArray，必然报错。
// 所以迁移前要把这几层壳剥掉，回到 companies 这个产出数组的表达式。
//
// 剥不干净的（例如 groupArray(city) 剥完是 city，但它不是数组列）
// 由调用方用列类型验证来决定给不给一键迁移，这里不做猜测。
func stripCollectShell(expr string) string {
	shells := []string{
		"arrayStringConcat", "arraySort", "arrayReverseSort", "arrayDistinct",
		"groupUniqArrayArray", "groupUniqArray", "groupArray",
	}
	out := strings.TrimSpace(expr)
	// 层数上限是防呆：壳不可能这么深，真到了这个深度说明解析出了问题，别死循环
	for i := 0; i < 6; i++ {
		changed := false
		for _, fn := range shells {
			if inner, ok := callArg(out, fn); ok {
				out = strings.TrimSpace(inner)
				changed = true
				break
			}
		}
		if !changed {
			return out
		}
	}
	return out
}

// callArg 判断 s 是否是完整的 fn(...) 调用，是则返回第一个实参。
// 例如 arrayStringConcat(x, ',') → x。
func callArg(s, fn string) (string, bool) {
	if len(s) < len(fn)+2 || s[len(fn)] != '(' || !strings.EqualFold(s[:len(fn)], fn) {
		return "", false
	}
	depth := 0
	inQuote := false
	for i := len(fn); i < len(s); i++ {
		c := s[i]
		if inQuote {
			// 转义字符跳过下一个，避免 '\'' 被当成字符串结束
			if c == '\\' {
				i++
				continue
			}
			if c == '\'' {
				inQuote = false
			}
			continue
		}
		switch c {
		case '\'':
			inQuote = true
		case '(':
			depth++
		case ')':
			depth--
			if depth == 0 {
				// 必须以右括号收尾，否则不是「整个表达式就是一个调用」
				if i != len(s)-1 {
					return "", false
				}
				inner := s[len(fn)+1 : i]
				if j := topLevelComma(inner); j >= 0 {
					inner = inner[:j]
				}
				return inner, true
			}
		}
	}
	return "", false
}

// topLevelComma 找第一个不在括号 / 字符串里的逗号。
func topLevelComma(s string) int {
	depth := 0
	inQuote := false
	for i := 0; i < len(s); i++ {
		c := s[i]
		if inQuote {
			if c == '\\' {
				i++
				continue
			}
			if c == '\'' {
				inQuote = false
			}
			continue
		}
		switch c {
		case '\'':
			inQuote = true
		case '(':
			depth++
		case ')':
			depth--
		case ',':
			if depth == 0 {
				return i
			}
		}
	}
	return -1
}

// arrayFieldReason 给出「这个字段像多值维度」的理由，不像就返回空串。
func arrayFieldReason(expr string, colTypes map[string]string) string {
	// 判据 1：底层列本身就是数组。最准，但要表达式是裸列名才对得上。
	if isBareIdent(expr) {
		if t, ok := colTypes[expr]; ok && strings.Contains(strings.ToUpper(t), "ARRAY(") {
			return "mid_sql 输出的该列是数组类型 " + t
		}
	}
	// 判据 2：表达式里用了数组函数
	if arrayFuncPattern.MatchString(expr) {
		return "表达式里用了数组函数"
	}
	return ""
}
