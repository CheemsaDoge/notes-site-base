## 线性变换的定义

设 $V, W$ 为数域 $\mathbb{F}$ 上的向量空间。映射 $T: V \to W$ 称为线性变换，若对任意 $u, v \in V$ 及 $\alpha, \beta \in \mathbb{F}$ 满足

$$T(\alpha u + \beta v) = \alpha T(u) + \beta T(v).$$

求导算子 $D(f) = f'$ 将光滑函数映到其一阶导数，是分析学中最常见的线性映射之一，且作用于连续函数空间的子空间上保持线性组合结构。

## 矩阵表示与自测

固定 $\mathbb{R}^2$ 的标准基 $e_1 = (1, 0)^T, e_2 = (0, 1)^T$，任意线性变换 $T: \mathbb{R}^2 \to \mathbb{R}^2$ 由矩阵 $A = [T(e_1)\ T(e_2)]$ 唯一确定。

:::solution 展开查看核空间计算解答
设 $T(x, y) = (x + 2y,\ 2x + 4y)$。对应矩阵为

$$A = \begin{pmatrix} 1 & 2 \\ 2 & 4 \end{pmatrix}.$$

解齐次方程组 $A\begin{pmatrix} x \\ y \end{pmatrix} = \begin{pmatrix} 0 \\ 0 \end{pmatrix}$ 得 $x = -2y$，因此核空间为

$$\ker(T) = \operatorname{span}\left\{\begin{pmatrix} -2 \\ 1 \end{pmatrix}\right\}, \quad \dim \ker(T) = 1.$$
:::

## 延伸阅读

- 上一节：[导数与局部线性逼近](./p01-derivative-intuition.html)
